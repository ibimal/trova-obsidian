// QueryController: one Instant search query at a time. It aborts the previous query, fans out
// to the three lanes (worker title lane, worker overlay or body lane, engine lex lane), merges
// them by Reciprocal Rank Fusion, and adds the semantic rows after a pause in typing.

import {
  OTHER_LANE_WEIGHT,
  SEMANTIC_ROWS_DELAY_MS,
  SEMANTIC_ROWS_MAX,
  SEMANTIC_ROWS_MIN_WORDS,
  TITLE_LANE_WEIGHT,
  blockId,
  isEmptyQuery,
  parseQuery,
  queryWordCount,
  recencyMultiplier,
  rrf,
  sourceId,
  type Capability,
  type Correction,
  type MatchedBy,
  type ParsedQuery,
  type QueryDiagnostic,
  type Result,
  type ResultBatch,
  type SearchRequest,
} from "@trova/contract";
import type { SearchOptions, SearchReply, WorkerHit } from "../worker/index.js";

export interface Row {
  /** The source id. Selection follows it, so a streamed update never loses the selected row. */
  id: string;
  collection: string;
  path: string;
  title: string;
  titleHighlights: [number, number][];
  snippet: string;
  highlights: [number, number][];
  /** Heading texts of the matched block. */
  headings: string[];
  blockId?: string;
  /** Offset of the match in the file, for scrolling. */
  offset?: number;
  matchedBy: MatchedBy[];
  score: number;
  modified: number;
  type?: string;
  alias?: string;
  context?: string;
}

export interface InstantState {
  raw: string;
  query: ParsedQuery;
  diagnostics: QueryDiagnostic[];
  rows: Row[];
  semantic: Row[];
  correction?: Correction;
  /** True while a keyword lane is still running. */
  pending: boolean;
  /** True while the semantic lane is still running. */
  refining: boolean;
}

export interface ControllerDeps {
  worker: { call(method: "search", args: [ParsedQuery, SearchOptions], signal?: AbortSignal): Promise<SearchReply> };
  engine: { ready: boolean; has(c: Capability): boolean; search(req: SearchRequest, signal?: AbortSignal): AsyncIterable<ResultBatch> };
  vaultCollection(): string;
  collections(): string[];
  settings(): { typoTolerance: 0 | 1 | 2; recencyBoost: boolean; semanticRows: boolean; fieldWeights: SearchOptions["weights"] };
  daysSinceOpened(path: string): number | null;
  knownKeys(): ReadonlySet<string> | undefined;
  semanticDelayMs?: number;
  /** How long the first paint waits for the engine's keyword lane; tests shorten it. */
  coalesceMs?: number;
  /** After a late engine lane, how long without a new keystroke before the full ranking shows. */
  settleMs?: number;
}

/**
 * The first paint of a keystroke waits this long for both keyword lanes, so it usually shows the
 * final list once instead of the worker's list and then a reordered one. The previous list stays
 * on screen meanwhile.
 */
const COALESCE_MS = 50;
/** A late engine lane is merged below the shown rows; the full ranking follows this much later. */
const SETTLE_MS = 300;

/**
 * The list to show when the engine's lane arrives after rows were already painted: the shown
 * rows keep their order and content, and new rows follow in the fused order. Rows that the
 * fused list no longer has are dropped.
 */
export function mergeBelow(shown: Row[], fused: Row[]): Row[] {
  const next = new Map(fused.map((r) => [r.id, r]));
  const kept = shown.filter((r) => next.has(r.id)).map((r) => ({ ...r, matchedBy: next.get(r.id)!.matchedBy }));
  const seen = new Set(kept.map((r) => r.id));
  return [...kept, ...fused.filter((r) => !seen.has(r.id))];
}

/**
 * Orders ids for display. The locked id (the selected or hovered row) keeps its index; every other
 * id follows the new order.
 */
export function stableOrder(prev: string[], next: string[], locked?: string | null): string[] {
  if (!locked) return next;
  const at = prev.indexOf(locked);
  if (at === -1 || !next.includes(locked)) return next;
  const rest = next.filter((id) => id !== locked);
  const index = Math.min(at, rest.length);
  return [...rest.slice(0, index), locked, ...rest.slice(index)];
}

export function fromWorker(hit: WorkerHit, collection: string): Row {
  const source = sourceId(collection, hit.path);
  return {
    id: source,
    collection,
    path: hit.path,
    title: hit.title,
    titleHighlights: hit.titleHighlights,
    snippet: hit.snippet,
    highlights: hit.highlights,
    headings: hit.block?.headings ?? [],
    ...(hit.block ? { blockId: blockId(source, hit.block.headingPath) } : {}),
    ...(hit.offset !== undefined ? { offset: hit.offset } : {}),
    matchedBy: [hit.matchedBy],
    score: 0,
    modified: hit.modified,
    ...(hit.alias ? { alias: hit.alias } : {}),
  };
}

export function fromEngine(r: Result, fallbackCollection: string): Row {
  return {
    id: r.source,
    collection: r.collection ?? fallbackCollection,
    path: r.path,
    title: r.title,
    titleHighlights: [],
    snippet: r.snippet,
    highlights: r.highlights,
    headings: r.block?.headings ?? [],
    ...(r.block ? { blockId: r.block.id, offset: r.block.start } : {}),
    matchedBy: [...r.matchedBy],
    score: 0,
    modified: 0,
    ...(r.type ? { type: r.type } : {}),
    ...(r.context ? { context: r.context } : {}),
  };
}

interface Lanes {
  title: Row[];
  body: Row[];
  engine: Row[];
}

/** Fuses the lanes: weight 2 for the title lane, 1 for the others, then recency, then ties. */
export function fuseLanes(lanes: Lanes, daysSinceOpened: (path: string) => number | null, recency: boolean): Row[] {
  const rows = new Map<string, Row>();
  const merge = (row: Row) => {
    const prev = rows.get(row.id);
    if (!prev) {
      rows.set(row.id, { ...row, matchedBy: [...row.matchedBy] });
      return;
    }
    for (const m of row.matchedBy) if (!prev.matchedBy.includes(m)) prev.matchedBy.push(m);
    // The first lane that has an excerpt or a block supplies it; later lanes only fill gaps.
    if (!prev.snippet && row.snippet) {
      prev.snippet = row.snippet;
      prev.highlights = row.highlights;
    }
    if (!prev.blockId && row.blockId) {
      prev.blockId = row.blockId;
      prev.headings = row.headings;
      prev.offset = row.offset;
    }
    if (prev.titleHighlights.length === 0) prev.titleHighlights = row.titleHighlights;
    prev.modified ||= row.modified;
    prev.type ??= row.type;
    prev.context ??= row.context;
    prev.alias ??= row.alias;
  };
  // Body lanes carry the matched block, so they are merged first; the title lane adds title highlights.
  for (const row of [...lanes.body, ...lanes.engine, ...lanes.title]) merge(row);
  const fused = rrf([
    { weight: TITLE_LANE_WEIGHT, items: lanes.title.map((r) => r.id) },
    { weight: OTHER_LANE_WEIGHT, items: lanes.body.map((r) => r.id) },
    { weight: OTHER_LANE_WEIGHT, items: lanes.engine.map((r) => r.id) },
  ]);
  const out = fused.map((f) => {
    const row = rows.get(f.id)!;
    row.score = f.score * (recency ? recencyMultiplier(daysSinceOpened(row.path)) : 1);
    return row;
  });
  return out.sort((a, b) => b.score - a.score || b.modified - a.modified || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export class QueryController {
  private abort: AbortController | null = null;
  private semanticTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: ControllerDeps) {}

  cancel(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.semanticTimer) clearTimeout(this.semanticTimer);
    this.semanticTimer = null;
    for (const timer of this.paintTimers) clearTimeout(timer);
    this.paintTimers = [];
  }

  /** The first-paint and settle timers of the running query. */
  private paintTimers: ReturnType<typeof setTimeout>[] = [];

  parse(raw: string): { query: ParsedQuery; diagnostics: QueryDiagnostic[] } {
    return parseQuery(raw, { knownKeys: this.deps.knownKeys() });
  }

  /**
   * Runs a query. `onUpdate` is called once per lane that arrives; the caller batches the calls
   * into one render per animation frame.
   */
  run(raw: string, onUpdate: (state: InstantState) => void, opts: { noFuzzy?: boolean } = {}): void {
    this.cancel();
    const abort = new AbortController();
    this.abort = abort;
    const { signal } = abort;
    const { query, diagnostics } = this.parse(raw);
    const settings = { ...this.deps.settings() };
    if (opts.noFuzzy) settings.typoTolerance = 0;
    const vault = this.deps.vaultCollection();
    const state: InstantState = { raw, query, diagnostics, rows: [], semantic: [], pending: false, refining: false };
    if (isEmptyQuery(query) || query.mode === "ask") {
      onUpdate(state);
      return;
    }
    const engineUp = this.deps.engine.ready;
    const lanes: Lanes = { title: [], body: [], engine: [] };
    let open = (engineUp ? 1 : 0) + 1;
    state.pending = true;
    // Painting: one paint once both keyword lanes are in, or after `coalesceMs` with what has
    // arrived. A lane that arrives after that is merged below the rows on screen, and the full
    // ranking replaces that list once the user pauses (`settleMs`) or the semantic rows arrive.
    const coalesceMs = this.deps.coalesceMs ?? COALESCE_MS;
    const settleMs = this.deps.settleMs ?? SETTLE_MS;
    const started = Date.now();
    let painted: Row[] | null = null;
    let firstTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = (ms: number, run: () => void) => {
      const id = setTimeout(() => {
        this.paintTimers = this.paintTimers.filter((t) => t !== id);
        if (!signal.aborted) run();
      }, ms);
      this.paintTimers.push(id);
      return id;
    };
    const emit = (rows: Row[]) => {
      if (signal.aborted) return;
      state.rows = rows;
      const shown = new Set(state.rows.map((r) => r.id));
      state.semantic = state.semantic.filter((r) => !shown.has(r.id));
      state.pending = open > 0;
      onUpdate({ ...state });
    };
    /** The full ranking of every lane so far. */
    const publish = () => {
      if (signal.aborted) return;
      if (firstTimer) clearTimeout(firstTimer);
      firstTimer = null;
      const rows = fuseLanes(lanes, this.deps.daysSinceOpened, settings.recencyBoost);
      painted = rows;
      emit(rows);
    };
    /** A keyword lane finished: paint now, wait for the other one, or merge below. */
    const laneDone = () => {
      if (signal.aborted) return;
      if (open <= 0) {
        if (painted && firstTimer === null) {
          // Rows are on screen from before this lane: add its new rows below them, then show the
          // full ranking after a pause in typing.
          const fused = fuseLanes(lanes, this.deps.daysSinceOpened, settings.recencyBoost);
          painted = mergeBelow(painted, fused);
          emit(painted);
          timer(settleMs, publish);
        } else publish();
        return;
      }
      if (painted || firstTimer) return;
      const wait = coalesceMs - (Date.now() - started);
      if (wait <= 0) return publish();
      firstTimer = timer(wait, () => {
        firstTimer = null;
        publish();
      });
    };
    const lexOnly = query.lane === "vec" || query.lane === "hyde";

    // Lanes 1 and 2: the worker answers from memory.
    if (!lexOnly) {
      this.deps.worker
        .call("search", [query, { limit: 50, fuzzy: settings.typoTolerance, weights: settings.fieldWeights, bodies: engineUp ? "overlay" : "all" }], signal)
        .then((reply) => {
          lanes.title = reply.title.map((h) => fromWorker(h, vault));
          lanes.body = reply.body.map((h) => fromWorker(h, vault));
          if (reply.correction && !state.correction) state.correction = reply.correction;
        })
        .catch(() => undefined)
        .finally(() => {
          open--;
          laneDone();
        });
    } else open--;

    // Lane 3: the engine's lex lane.
    if (engineUp && !lexOnly) {
      (async () => {
        try {
          const req: SearchRequest = { query, lanes: ["lex"], collections: this.deps.collections(), limit: 30, fuzzy: settings.typoTolerance > 0, deadlineMs: 250 };
          for await (const batch of this.deps.engine.search(req, signal)) {
            if (signal.aborted) return;
            lanes.engine = batch.results.map((r) => fromEngine(r, vault));
            // The worker saw the title lane too; when it found a correction, keep it.
            if (batch.correction && lanes.title.length + lanes.body.length === 0) state.correction = batch.correction;
          }
        } catch {
          /* the engine lane failing leaves the worker's results in place */
        } finally {
          open--;
          laneDone();
        }
      })();
    } else if (engineUp) open--;

    // Semantic rows: after a pause in typing, for queries of three or more words.
    const wantsVec = lexOnly || (settings.semanticRows && queryWordCount(query) >= SEMANTIC_ROWS_MIN_WORDS);
    if (engineUp && wantsVec && this.deps.engine.has("vec")) {
      state.refining = true;
      this.semanticTimer = setTimeout(
        () => {
          (async () => {
            try {
              const req: SearchRequest = { query, lanes: ["vec"], collections: this.deps.collections(), limit: lexOnly ? 20 : SEMANTIC_ROWS_MAX * 3, deadlineMs: 1500 };
              for await (const batch of this.deps.engine.search(req, signal)) {
                if (signal.aborted) return;
                const shown = new Set(state.rows.map((r) => r.id));
                state.semantic = batch.results
                  .map((r) => fromEngine(r, vault))
                  .filter((r) => !shown.has(r.id))
                  .slice(0, lexOnly ? 20 : SEMANTIC_ROWS_MAX);
              }
            } catch {
              /* no semantic rows */
            } finally {
              if (!signal.aborted) {
                state.refining = false;
                publish();
              }
            }
          })();
        },
        lexOnly ? 0 : (this.deps.semanticDelayMs ?? SEMANTIC_ROWS_DELAY_MS),
      );
    }
    if (open <= 0) publish();
  }
}
