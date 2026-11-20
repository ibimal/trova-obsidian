// The public API: other plugins, Templater scripts and Dataview JS reach Trova through
// `app.plugins.plugins.trova.api`. Every method is async and takes an AbortSignal.

import { blockId, formatContext, parseQuery, slugHeading, sourceId, type ContextFormat, type EngineAnchor, type Filter, type IndexStatus, type Result, type ResultBatch } from "@trova/contract";
import type TrovaPlugin from "../main.js";
import { QueryController, type InstantState, type Row } from "../query/controller.js";
import { itemKey, piecesFor, type BasketItem } from "./basket.js";

export interface Opts {
  signal?: AbortSignal;
  limit?: number;
  filters?: Filter[];
  collections?: string[];
}
export type SearchOpts = Opts;
export interface AskOpts extends Opts {
  mode?: "auto" | "fast" | "deep";
}
export interface RelatedOpts extends Opts {
  loose?: boolean;
}
export type Anchor = { path: string } | { path: string; block: string } | { text: string };
export interface ContextItem {
  path: string;
  /** A heading path such as "setup/install", or a heading text. */
  block?: string;
  neighbours?: boolean;
}
export type TrovaEvent = "index:progress" | "index:ready" | "results:stale" | "engine:state" | "model:changed";
export type EventPayload = Record<string, unknown>;

export interface TrovaApi {
  version: string;
  search(query: string, opts?: SearchOpts): AsyncIterable<ResultBatch>;
  ask(question: string, opts?: AskOpts): AsyncIterable<ResultBatch>;
  related(anchor: Anchor, opts?: RelatedOpts): Promise<Result[]>;
  score(a: Anchor, b: Anchor, opts?: Opts): Promise<number>;
  context(items: ContextItem[], format: ContextFormat, opts?: Opts): Promise<string>;
  status(): Promise<IndexStatus>;
  on(event: TrovaEvent, cb: (e: EventPayload) => void): () => void;
}

export function rowToResult(row: Row, rank: number): Result {
  const result: Result = {
    id: row.blockId ?? row.id,
    source: row.id,
    path: row.path,
    title: row.title,
    collection: row.collection,
    snippet: row.snippet,
    highlights: row.highlights,
    scores: { fused: row.score, fusedRank: rank },
    matchedBy: row.matchedBy,
    label: rank <= 3 ? "strong" : rank <= 10 ? "related" : "loose",
  };
  if (row.blockId) result.block = { id: row.blockId, headings: row.headings, start: row.offset ?? 0, end: row.offset ?? 0 };
  if (row.type) result.type = row.type;
  return result;
}

export function createApi(plugin: TrovaPlugin): TrovaApi {
  const toEngine = (a: Anchor): EngineAnchor => {
    if ("text" in a) return { text: a.text };
    const source = sourceId(plugin.collection, a.path);
    if ("block" in a && a.block !== undefined) return { block: blockId(source, a.block.includes(" ") || /[A-Z]/.test(a.block) ? slugHeading(a.block) : a.block) };
    return { source };
  };
  const withFilters = (raw: string, opts?: Opts, mode?: "ask") => {
    const query = parseQuery(raw, { mode: mode ?? "instant", knownKeys: plugin.knownKeys() }).query;
    if (opts?.filters?.length) query.filters.push(...opts.filters);
    return query;
  };
  return {
    version: plugin.manifest.version,

    /** Instant lane: streams the fused keyword results, then the semantic rows. */
    async *search(query, opts) {
      const controller = new QueryController({ ...plugin.controllerDeps(), semanticDelayMs: 0, collections: () => opts?.collections ?? plugin.engine.collections() });
      const limit = opts?.limit ?? 20;
      const queue: InstantState[] = [];
      let wake: (() => void) | null = null;
      opts?.signal?.addEventListener("abort", () => {
        controller.cancel();
        wake?.();
      });
      const raw = opts?.filters?.length ? query : query;
      controller.run(raw, (state) => {
        queue.push(state);
        wake?.();
      });
      let sentLex = false;
      for (;;) {
        if (opts?.signal?.aborted) return;
        const state = queue.shift();
        if (!state) {
          await new Promise<void>((r) => (wake = r));
          wake = null;
          continue;
        }
        const done = !state.pending && !state.refining;
        if (!state.pending && !sentLex) {
          sentLex = true;
          yield { stage: "lex", results: state.rows.slice(0, limit).map((r, i) => rowToResult(r, i + 1)), final: done, ...(state.correction ? { correction: state.correction } : {}) };
        } else if (done && sentLex) {
          yield { stage: "vec", results: state.semantic.slice(0, limit).map((r, i) => rowToResult(r, i + 1)), final: true };
        }
        if (done) return;
      }
    },

    ask(question, opts) {
      return plugin.engine.ask(
        { query: withFilters(question, opts, "ask"), mode: opts?.mode ?? plugin.settings.askMode, collections: opts?.collections ?? plugin.engine.collections(), limit: opts?.limit ?? 20 },
        opts?.signal,
      );
    },

    async related(anchor, opts) {
      const res = await plugin.engine.related(
        { anchor: toEngine(anchor), granularity: "both", limit: opts?.limit ?? 20, filters: opts?.filters ?? [], collections: opts?.collections ?? plugin.engine.collections(), loose: opts?.loose ?? plugin.settings.showLoose },
        opts?.signal,
      );
      return res.results;
    },

    async score(a, b, opts) {
      const res = await plugin.engine.score({ pairs: [[toEngine(a), toEngine(b)]] }, opts?.signal);
      return res.scores[0] ?? 0;
    },

    async context(items, format, opts) {
      const basketItems: BasketItem[] = items.map((it) => {
        const headingPath = it.block === undefined ? undefined : it.block.includes(" ") || /[A-Z]/.test(it.block) ? slugHeading(it.block) : it.block;
        return {
          key: itemKey(it.path, headingPath, it.neighbours),
          path: it.path,
          title: it.path.split("/").pop()!.replace(/\.md$/, ""),
          kind: headingPath === undefined ? "note" : it.neighbours ? "neighbours" : "block",
          ...(headingPath !== undefined ? { headingPath } : {}),
        };
      });
      return formatContext(await piecesFor(plugin.app, basketItems, undefined, opts?.signal), format);
    },

    async status() {
      const status = await plugin.engine.refreshStatus();
      if (status) return status;
      // Without the engine, the worker's keyword index is the whole index.
      const stats = await plugin.worker.stats();
      return {
        api: "1.0",
        engine: { name: "trova-worker", version: plugin.manifest.version, backend: "minisearch" },
        capabilities: ["lex", "fuzzy", "blocks"],
        models: { embed: { state: "missing" }, rerank: { state: "missing" }, expand: { state: "missing" } },
        collections: [{ name: plugin.collection, path: "", sources: stats.files, embedded: 0, pending: 0 }],
        jobs: [],
      };
    },

    on(event, cb) {
      const name = event.replace(":", ".");
      return plugin.engine.onEvent((e) => {
        if (e.event === name) cb(e.data);
      });
    },
  };
}
