// The worker's search index: a MiniSearch index over titles, aliases, headings, tags and note
// bodies, plus the overlay of notes edited since the engine last indexed. This class has no
// dependency on the worker globals, so tests drive it directly.

import MiniSearch, { type Query, type SearchResult } from "minisearch";
import {
  blockAt,
  createLinkResolver,
  damerauLevenshtein,
  findInText,
  findMentions,
  fold,
  hasCjk,
  lightStem,
  makeSnippet,
  matchesFilters,
  matchesTerms,
  queryRanges,
  splitBlocks,
  termRanges,
  typoMaxEdits,
  type Block,
  type Correction,
  type LineMatch,
  type LinkResolver,
  type ParsedQuery,
  type SourceMeta,
  type Term,
} from "@trova/contract";

export interface WorkerDoc extends SourceMeta {
  headings: { text: string; level: number; offset: number }[];
}

export interface WorkerHit {
  path: string;
  title: string;
  score: number;
  matchedBy: "lex" | "fuzzy";
  /** Where the best match is: "title", "alias", "heading", "tag" or "body". */
  field: string;
  snippet: string;
  highlights: [number, number][];
  /** Title highlights, as ranges in the title. */
  titleHighlights: [number, number][];
  block?: { headingPath: string; headings: string[]; start: number; end: number };
  /** Offset of the match in the file, for scrolling. */
  offset?: number;
  modified: number;
  /** Set when the match is on an alias, so the row can show it. */
  alias?: string;
}

export interface SearchOptions {
  limit?: number;
  fuzzy?: 0 | 1 | 2;
  weights?: { filename: number; aliases: number; headings: number; body: number };
  /** Which body lane to run next to the title lane. */
  bodies?: "none" | "overlay" | "all";
}

export interface SearchReply {
  title: WorkerHit[];
  body: WorkerHit[];
  correction?: Correction;
}

export interface MentionHit {
  path: string;
  title: string;
  mentions: { start: number; end: number; name: string; context: string; contextStart: number }[];
}

interface Indexed {
  id: string;
  title: string;
  aliases: string;
  headings: string;
  tags: string;
  folder: string;
  body: string;
}

const DEFAULT_WEIGHTS = { filename: 4, aliases: 3, headings: 2, body: 1 };
const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]+/g;

function tokenize(text: string): string[] {
  return text
    .replace(CJK_RUN, (run) => ` ${Array.from(run).join(" ")} `)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function processTerm(term: string): string {
  const t = fold(term);
  return hasCjk(t) ? t : lightStem(t);
}

export class SearchIndex {
  private mini = this.createIndex();
  private docs = new Map<string, WorkerDoc>();
  private bodies = new Map<string, string>();
  private blockCache = new Map<string, Block[]>();
  private dirty = new Set<string>();
  private signatures = new Map<string, string>();
  private resolver: LinkResolver | null = null;
  private inbound: Map<string, number> | null = null;

  private createIndex(): MiniSearch<Indexed> {
    return new MiniSearch<Indexed>({
      fields: ["title", "aliases", "headings", "tags", "folder", "body"],
      idField: "id",
      tokenize,
      processTerm,
      searchOptions: { tokenize, processTerm },
    });
  }

  // ---------- updates ----------

  private indexed(doc: WorkerDoc): Indexed {
    return {
      id: doc.path,
      title: doc.title,
      aliases: doc.aliases.join("\n"),
      headings: doc.headings.map((h) => h.text).join("\n"),
      tags: doc.tags.join(" "),
      folder: doc.path.includes("/") ? doc.path.slice(0, doc.path.lastIndexOf("/")) : "",
      body: this.bodies.get(doc.path) ?? "",
    };
  }

  /** The text MiniSearch holds for a note, without the body. Unchanged text needs no re-index. */
  private signature(doc: WorkerDoc): string {
    return `${doc.path}\u0000${doc.title}\u0000${doc.aliases.join("\u0001")}\u0000${doc.headings.map((h) => h.text).join("\u0001")}\u0000${doc.tags.join(" ")}`;
  }

  private put(doc: WorkerDoc): void {
    if (this.mini.has(doc.path)) this.mini.discard(doc.path);
    this.docs.set(doc.path, doc);
    this.mini.add(this.indexed(doc));
    this.signatures.set(doc.path, this.signature(doc));
    this.resolver = null;
    this.inbound = null;
  }

  upsertMeta(docs: WorkerDoc[]): void {
    for (const doc of docs) {
      // Re-indexing a note tokenises its whole body again, so it is skipped when only links,
      // dates or frontmatter changed.
      if (this.signatures.get(doc.path) === this.signature(doc)) {
        const prev = this.docs.get(doc.path);
        this.docs.set(doc.path, doc.wordCount === 0 && prev ? { ...doc, wordCount: prev.wordCount } : doc);
        this.resolver = null;
        this.inbound = null;
      } else this.put(doc);
    }
  }

  /** Adds or replaces note bodies. `dirty` marks them as newer than the engine's index. */
  upsertBodies(items: { path: string; body: string }[], dirty = false): void {
    for (const item of items) {
      const doc = this.docs.get(item.path);
      if (!doc) continue;
      if (this.bodies.get(item.path) === item.body) {
        if (dirty) this.dirty.add(item.path);
        continue;
      }
      this.bodies.set(item.path, item.body);
      this.blockCache.delete(item.path);
      if (dirty) this.dirty.add(item.path);
      this.put(doc);
    }
  }

  remove(paths: string[]): void {
    for (const path of paths) {
      if (this.mini.has(path)) this.mini.discard(path);
      this.docs.delete(path);
      this.signatures.delete(path);
      this.bodies.delete(path);
      this.blockCache.delete(path);
      this.dirty.delete(path);
    }
    this.resolver = null;
    this.inbound = null;
  }

  rename(from: string, to: string, title: string): void {
    const doc = this.docs.get(from);
    if (!doc) return;
    const body = this.bodies.get(from);
    const wasDirty = this.dirty.has(from);
    this.remove([from]);
    if (body !== undefined) this.bodies.set(to, body);
    if (wasDirty) this.dirty.add(to);
    this.put({ ...doc, path: to, title });
  }

  /** Marks notes as indexed by the engine; they leave the overlay. No argument clears it all. */
  clearDirty(paths?: string[]): void {
    if (!paths) this.dirty.clear();
    else for (const p of paths) this.dirty.delete(p);
  }

  markDirty(paths: string[]): void {
    for (const p of paths) if (this.docs.has(p)) this.dirty.add(p);
  }

  stats(): { files: number; bodies: number; dirty: number } {
    return { files: this.docs.size, bodies: this.bodies.size, dirty: this.dirty.size };
  }

  has(path: string): boolean {
    return this.docs.has(path);
  }

  // ---------- helpers ----------

  private graph(): { resolver: LinkResolver; inbound: Map<string, number> } {
    if (!this.resolver || !this.inbound) {
      this.resolver = createLinkResolver(this.docs.keys());
      this.inbound = new Map();
      for (const d of this.docs.values()) for (const l of d.links) this.inbound.set(l, (this.inbound.get(l) ?? 0) + 1);
    }
    return { resolver: this.resolver, inbound: this.inbound };
  }

  private blocks(path: string): Block[] {
    let b = this.blockCache.get(path);
    if (!b) {
      b = splitBlocks(this.bodies.get(path) ?? "");
      this.blockCache.set(path, b);
      if (this.blockCache.size > 500) this.blockCache.delete(this.blockCache.keys().next().value!);
    }
    return b;
  }

  private passes(doc: WorkerDoc, q: ParsedQuery): boolean {
    if (doc.excluded) return false;
    if (q.filters.length === 0) return true;
    const g = this.graph();
    return matchesFilters(doc, q.filters, {
      resolveLink: g.resolver,
      isOrphan: (path) => (this.docs.get(path)?.links.length ?? 0) === 0 && !g.inbound.get(path),
    });
  }

  private termQuery(term: Term, fields: string[], fuzzy: 0 | 1 | 2): Query | null {
    const tokens = tokenize(term.text);
    if (tokens.length === 0) return null;
    const scoped = term.field === "title" ? ["title", "aliases"] : term.field === "heading" ? ["headings"] : fields;
    const usable = scoped.filter((f) => fields.includes(f) || term.field !== undefined);
    if (usable.length === 0) return null;
    const exact = term.kind !== "word";
    return {
      combineWith: "AND",
      queries: tokens.map((token) => ({
        queries: [token],
        fields: usable,
        prefix: !exact && !hasCjk(token),
        fuzzy: exact || fuzzy === 0 ? false : (t: string) => (typoMaxEdits(t, fuzzy) > 0 ? typoMaxEdits(t, fuzzy) : false),
      })),
    } as Query;
  }

  private buildQuery(q: ParsedQuery, fields: string[], fuzzy: 0 | 1 | 2): Query | null {
    const groups: Query[] = [];
    for (const group of q.must) {
      const parts = group.map((t) => this.termQuery(t, fields, fuzzy)).filter((p): p is Query => p !== null);
      if (parts.length === 0) return null;
      groups.push(parts.length === 1 ? parts[0]! : ({ combineWith: "OR", queries: parts } as Query));
    }
    if (groups.length === 0) return null;
    return { combineWith: "AND", queries: groups } as Query;
  }

  private run(q: ParsedQuery, fields: string[], fuzzy: 0 | 1 | 2, weights: SearchOptions["weights"], only?: Set<string>): SearchResult[] {
    const query = this.buildQuery(q, fields, fuzzy);
    if (!query) return [];
    const w = weights ?? DEFAULT_WEIGHTS;
    const strict = q.mustNot.length > 0 || q.must.some((g) => g.some((t) => t.kind !== "word"));
    return this.mini.search(query, {
      boost: { title: w.filename, aliases: w.aliases, headings: w.headings, tags: w.headings, folder: w.body, body: w.body },
      filter: (r) => {
        const path = r.id as string;
        if (only && !only.has(path)) return false;
        const doc = this.docs.get(path);
        if (!doc || !this.passes(doc, q)) return false;
        if (!strict) return true;
        // Phrases, exact words and exclusions are verified against the text itself.
        return matchesTerms({ title: doc.title, aliases: doc.aliases, headings: doc.headings.map((h) => h.text), body: this.bodies.get(path) ?? "" }, { ...q, must: q.must.filter((g) => g.some((t) => t.kind !== "word")) });
      },
    });
  }

  private toHit(r: SearchResult, q: ParsedQuery, lane: "title" | "body", matchedBy: "lex" | "fuzzy"): WorkerHit {
    const path = r.id as string;
    const doc = this.docs.get(path)!;
    const body = this.bodies.get(path) ?? "";
    const hit: WorkerHit = {
      path,
      title: doc.title,
      score: r.score,
      matchedBy,
      field: "title",
      snippet: "",
      highlights: [],
      titleHighlights: queryRanges(doc.title, q),
      modified: doc.modified,
    };
    const terms = q.must.flat();
    const inText = (text: string) => terms.some((t) => termRanges(text, t, 1).length > 0);
    const bodyRanges = body ? queryRanges(body, q) : [];
    const setBlock = (offset: number) => {
      const block = blockAt(this.blocks(path), offset);
      if (block && body) hit.block = { headingPath: block.headingPath, headings: block.headings, start: block.start, end: block.end };
      hit.offset = offset;
    };
    if (lane === "title") {
      if (hit.titleHighlights.length > 0) hit.field = "title";
      else {
        const alias = doc.aliases.find(inText);
        const heading = doc.headings.find((h) => inText(h.text));
        if (alias) {
          hit.field = "alias";
          hit.alias = alias;
        } else if (heading) {
          hit.field = "heading";
          setBlock(heading.offset);
        } else if (doc.tags.some((t) => inText(t))) hit.field = "tag";
      }
    } else hit.field = "body";
    if (bodyRanges.length > 0) {
      const first = hit.field === "heading" && hit.offset !== undefined ? hit.offset : bodyRanges[0]![0];
      if (hit.field === "body") setBlock(first);
      const block = hit.block;
      const snip = block ? makeSnippet(body, bodyRanges, 180, block.start, block.end) : makeSnippet(body, bodyRanges, 180);
      hit.snippet = snip.snippet;
      hit.highlights = snip.highlights;
      if (hit.field === "body") hit.offset = bodyRanges.find((x) => !block || (x[0] >= block.start && x[0] < block.end))?.[0] ?? first;
    } else if (body) {
      const from = hit.block?.start ?? 0;
      const snip = makeSnippet(body, [], 180, Math.max(from, hit.block ? from : this.fmEnd(body)), hit.block?.end ?? body.length);
      hit.snippet = snip.snippet;
    }
    return hit;
  }

  private fmEnd(body: string): number {
    if (!body.startsWith("---")) return 0;
    const m = /\n---[ \t]*(\r?\n|$)/.exec(body);
    return m ? m.index + m[0].length : 0;
  }

  // ---------- search ----------

  search(q: ParsedQuery, opts: SearchOptions = {}): SearchReply {
    const limit = opts.limit ?? 50;
    const fuzzy = opts.fuzzy ?? 1;
    const bodies = opts.bodies ?? "all";
    const only = bodies === "overlay" ? this.dirty : undefined;
    const hasTerms = q.must.length > 0;

    if (!hasTerms) {
      // A query made only of filters lists the matching notes, newest first.
      if (q.filters.length === 0) return { title: [], body: [] };
      const title = [...this.docs.values()]
        .filter((d) => this.passes(d, q))
        .sort((a, b) => b.modified - a.modified || (a.path < b.path ? -1 : 1))
        .slice(0, limit)
        .map((d): WorkerHit => ({ path: d.path, title: d.title, score: 0, matchedBy: "lex", field: "title", snippet: "", highlights: [], titleHighlights: [], modified: d.modified }));
      return { title, body: [] };
    }

    const lanes = (query: ParsedQuery) => ({
      title: this.run(query, ["title", "aliases", "headings", "tags", "folder"], 0, opts.weights),
      body: bodies === "none" || (only && only.size === 0) ? [] : this.run(query, ["body"], 0, opts.weights, only),
    });
    let found = lanes(q);
    let matchedBy: "lex" | "fuzzy" = "lex";
    let correction: Correction | undefined;
    // Highlights follow the corrected words.
    let shown = q;
    const count = new Set([...found.title, ...found.body].map((r) => r.id)).size;
    if (fuzzy > 0 && count < 3) {
      // Typo rescue: each word that is absent from the index is replaced by the index word within
      // the allowed edits that occurs in the most notes.
      const from: string[] = [];
      const to: string[] = [];
      const must = q.must.map((group) =>
        group.map((term) => {
          const max = term.kind === "word" ? typoMaxEdits(term.text, fuzzy) : 0;
          if (max === 0 || this.mini.search({ queries: [term.text], prefix: true } as Query, { fuzzy: false }).length > 0) return term;
          const best = this.correct(term.text, max);
          if (!best) return term;
          from.push(term.text);
          to.push(best);
          return { ...term, text: best };
        }),
      );
      if (from.length > 0) {
        const corrected = { ...q, must };
        const rescued = lanes(corrected);
        if (new Set([...rescued.title, ...rescued.body].map((r) => r.id)).size > count) {
          found = rescued;
          matchedBy = "fuzzy";
          shown = corrected;
          correction = { from: from.join(" "), to: to.join(" ") };
        }
      }
    }
    return {
      title: found.title.slice(0, limit).map((r) => this.toHit(r, shown, "title", matchedBy)),
      body: found.body.slice(0, limit).map((r) => this.toHit(r, shown, "body", matchedBy)),
      ...(correction ? { correction } : {}),
    };
  }

  /**
   * The index word closest to a misspelt word. MiniSearch counts a swap of two letters as two
   * edits, so it searches one edit wider and Damerau-Levenshtein, which counts a swap as one,
   * decides. Among the words within `max` edits, the one in the most notes wins.
   */
  private correct(word: string, max: number): string | null {
    const stem = processTerm(word);
    const hits = this.mini.search({ queries: [word], prefix: false, fuzzy: Math.min(3, max + 1) } as Query, { filter: (r) => !this.docs.get(r.id as string)?.excluded });
    const counts = new Map<string, { n: number; distance: number; path: string }>();
    for (const r of hits) {
      for (const term of Object.keys(r.match)) {
        if (term === stem) continue;
        const known = counts.get(term);
        if (known) {
          known.n++;
          continue;
        }
        const distance = damerauLevenshtein(stem, term, max);
        if (distance <= max) counts.set(term, { n: 1, distance, path: r.id as string });
      }
    }
    const best = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || a[1].distance - b[1].distance || (a[0] < b[0] ? -1 : 1))[0];
    return best ? this.unstem(best[0], best[1].path) : null;
  }

  /** The index holds stems; the correction shows the word as it is written in the best hit. */
  private unstem(stem: string, path: string | undefined): string {
    const doc = path ? this.docs.get(path) : undefined;
    if (!doc) return stem;
    const text = `${doc.title}\n${doc.aliases.join("\n")}\n${doc.headings.map((h) => h.text).join("\n")}\n${doc.tags.join(" ")}\n${this.bodies.get(doc.path) ?? ""}`;
    for (const token of tokenize(text)) if (processTerm(token) === stem) return fold(token);
    return stem;
  }

  /** Title-lane matches for `[[` suggestions: titles and aliases only, as a prefix. */
  suggest(text: string, limit = 30): { path: string; title: string; alias?: string; score: number }[] {
    const tokens = tokenize(text);
    if (tokens.length === 0) return [];
    const results = this.mini.search({ combineWith: "AND", queries: tokens.map((t) => ({ queries: [t], prefix: true })) } as Query, {
      fields: ["title", "aliases"],
      boost: { title: 2 },
      filter: (r) => !this.docs.get(r.id as string)?.excluded,
    });
    return results.slice(0, limit).map((r) => {
      const doc = this.docs.get(r.id as string)!;
      const titleHit = tokens.every((t) => fold(doc.title).includes(fold(t)));
      const alias = titleHit ? undefined : doc.aliases.find((a) => tokens.some((t) => fold(a).includes(fold(t))));
      return { path: doc.path, title: doc.title, ...(alias ? { alias } : {}), score: r.score };
    });
  }

  /** Notes that mention a title or alias without linking to that note. */
  mentions(names: string[], selfPath: string, limit = 200): MentionHit[] {
    const out: MentionHit[] = [];
    const usable = names.filter((n) => n.trim().length >= 3);
    if (usable.length === 0) return out;
    for (const [path, body] of this.bodies) {
      if (path === selfPath) continue;
      const doc = this.docs.get(path);
      if (!doc || doc.excluded || doc.links.includes(selfPath)) continue;
      // A cheap containment check first; most notes mention nothing.
      const folded = fold(body);
      if (!usable.some((n) => folded.includes(fold(n)))) continue;
      const found = findMentions(body, usable);
      if (found.length === 0) continue;
      out.push({
        path,
        title: doc.title,
        mentions: found.slice(0, 20).map((m) => {
          const lineStart = body.lastIndexOf("\n", m.start) + 1;
          let lineEnd = body.indexOf("\n", m.end);
          if (lineEnd === -1) lineEnd = body.length;
          const from = Math.max(lineStart, m.start - 80);
          return { ...m, context: body.slice(from, Math.min(lineEnd, m.end + 80)), contextStart: from };
        }),
      });
      if (out.length >= limit) break;
    }
    return out.sort((a, b) => b.mentions.length - a.mentions.length);
  }

  /** In-file search over the worker's copy of a note. */
  inFile(path: string, q: ParsedQuery): LineMatch[] {
    return findInText(this.bodies.get(path) ?? "", q);
  }

  body(path: string): string | undefined {
    return this.bodies.get(path);
  }

  /** Notes with no links in or out. */
  orphans(): string[] {
    const g = this.graph();
    return [...this.docs.values()].filter((d) => !d.excluded && d.path.endsWith(".md") && d.links.length === 0 && !g.inbound.get(d.path)).map((d) => d.path);
  }
}
