// ConnectionsService: related results for an anchor, with the per-anchor cache, pins, hides and
// pane filters. The pane, the inline badges, the footer, orphan rescue and Rediscover all use it.

import { TFile, type App } from "obsidian";
import {
  MIN_ANCHOR_WORDS,
  blockId,
  blockText,
  countWords,
  findBlock,
  frontmatterEnd,
  parseId,
  sourceId,
  splitBlocks,
  type Filter,
  type RelatedRequest,
  type Result,
} from "@trova/contract";
import type { EngineManager } from "../engine/manager.js";
import type { TrovaSettings } from "../settings.js";
import { Lru, type DataStore } from "../state/store.js";
import { hashText } from "../ui.js";

export type Anchor =
  | { kind: "note"; path: string }
  | { kind: "block"; path: string; headingPath: string; headings: string[] }
  | { kind: "selection"; path: string; text: string };

export type RelatedState = "ok" | "tooShort" | "excluded" | "offline" | "notIndexed" | "noNote";

export interface RelatedView {
  state: RelatedState;
  anchor: Anchor | null;
  results: Result[];
  /** True while a newer edit of the anchor is not indexed yet. */
  stale: boolean;
  pinned: Set<string>;
}

interface Cached {
  hash: string;
  results: Result[];
}

export function anchorKey(a: Anchor): string {
  if (a.kind === "note") return `n:${a.path}`;
  if (a.kind === "block") return `b:${a.path}#${a.headingPath}`;
  return `s:${a.path}:${hashText(a.text)}`;
}

export interface ConnectionsDeps {
  app: App;
  engine: EngineManager;
  store: DataStore;
  settings(): TrovaSettings;
  isExcluded(path: string): boolean;
}

export class ConnectionsService {
  private cache = new Lru<string, Cached>(200);
  /** Sources the engine reported as changed; their cached results are outdated. */
  private staleSources = new Set<string>();

  constructor(private deps: ConnectionsDeps) {}

  collection(): string {
    return this.deps.engine.vaultCollection;
  }

  anchorSource(a: Anchor): string {
    return sourceId(this.collection(), a.path);
  }

  markStale(sources: string[]): void {
    for (const s of sources) this.staleSources.add(s);
  }

  dropPath(path: string): void {
    for (const key of this.cache.keys()) if (key.slice(2).startsWith(path)) this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  /** Pane filters from the settings and the persisted filter list. */
  private filters(): { filters: Filter[]; hideLinked: boolean } {
    return { filters: this.deps.store.data.filters.connections, hideLinked: this.deps.settings().hideLinked };
  }

  private async anchorText(a: Anchor): Promise<{ text: string; whole: string } | null> {
    if (a.kind === "selection") return { text: a.text, whole: a.text };
    const file = this.deps.app.vault.getAbstractFileByPath(a.path);
    if (!(file instanceof TFile)) return null;
    const whole = await this.deps.app.vault.cachedRead(file);
    if (a.kind === "note") return { text: whole.slice(frontmatterEnd(whole)), whole };
    const block = findBlock(splitBlocks(whole), a.headingPath);
    return block ? { text: blockText(whole, block), whole } : null;
  }

  /** Applies hides and pins: hidden results never return for the anchor; pinned ones stay on top. */
  private decorate(a: Anchor, results: Result[]): { results: Result[]; pinned: Set<string> } {
    const anchor = this.anchorSource(a);
    const hidden = new Set(this.deps.store.hides(anchor));
    const pins = this.deps.store.pins(anchor);
    const pinned = new Set(pins);
    const settings = this.deps.settings();
    const visible = results.filter((r) => !hidden.has(r.id) && !hidden.has(r.source) && (settings.showLoose || r.label !== "loose" || pinned.has(r.id)));
    const top = visible.filter((r) => pinned.has(r.id));
    const rest = visible.filter((r) => !pinned.has(r.id));
    // A pinned result that the engine no longer returns still shows, without a score.
    for (const id of pins) {
      if (top.some((r) => r.id === id)) continue;
      const parsed = parseId(id);
      if (!parsed || hidden.has(id)) continue;
      top.push({ id, source: parsed.source, path: parsed.path, title: parsed.path.split("/").pop()!.replace(/\.md$/, ""), collection: parsed.collection, snippet: "", highlights: [], scores: {}, matchedBy: [], label: "related" });
    }
    return { results: [...top, ...rest], pinned };
  }

  cached(a: Anchor): RelatedView | null {
    const hit = this.cache.get(anchorKey(a));
    if (!hit) return null;
    const { results, pinned } = this.decorate(a, hit.results);
    return { state: "ok", anchor: a, results, stale: this.staleSources.has(this.anchorSource(a)), pinned };
  }

  /**
   * Related results for an anchor. Cached results are returned by `cached`; this call refreshes
   * them. A note that is not embedded yet is embedded live from its text.
   */
  async related(a: Anchor, signal?: AbortSignal, limit = 30): Promise<RelatedView> {
    const empty = (state: RelatedState): RelatedView => ({ state, anchor: a, results: [], stale: false, pinned: new Set() });
    if (this.deps.isExcluded(a.path)) return empty("excluded");
    const text = await this.anchorText(a);
    if (!text) return empty("noNote");
    if (countWords(text.text) < MIN_ANCHOR_WORDS) return empty("tooShort");
    if (!this.deps.engine.ready) {
      const cached = this.cached(a);
      return cached ? { ...cached, state: "offline" } : empty("offline");
    }
    const key = anchorKey(a);
    const hash = hashText(text.text);
    const source = this.anchorSource(a);
    const hit = this.cache.get(key);
    const { filters, hideLinked } = this.filters();
    const settings = this.deps.settings();
    const base: RelatedRequest = {
      anchor: {},
      granularity: "both",
      limit,
      blocksPerSource: 3,
      exclude: { sources: a.kind === "selection" ? [source] : [], linkedFromAnchor: hideLinked },
      filters: [...filters],
      collections: this.deps.engine.collections(),
      loose: settings.showLoose,
    };
    const edited = hit !== undefined && hit.hash !== hash;
    const anchorId = a.kind === "block" ? { block: blockId(source, a.headingPath) } : a.kind === "note" ? { source } : { text: a.text.slice(0, 8000) };
    let res = await this.deps.engine.related({ ...base, anchor: anchorId }, signal).catch((err) => {
      if ((err as { code?: string }).code === "not_found") return { anchorIndexed: false, results: [] };
      throw err;
    });
    let live = false;
    if (!res.anchorIndexed && a.kind !== "selection") {
      // Not embedded yet: embed the text live.
      live = true;
      res = await this.deps.engine.related({ ...base, anchor: { text: text.text.slice(0, 8000) }, exclude: { ...base.exclude, sources: [source] } }, signal);
      if (!res.anchorIndexed) return empty("notIndexed");
    }
    this.cache.set(key, { hash, results: res.results });
    if (!live && !edited) this.staleSources.delete(source);
    const { results, pinned } = this.decorate(a, res.results);
    return { state: "ok", anchor: a, results, stale: live || this.staleSources.has(source), pinned };
  }

  /** Strong matches for one section, for the inline badges. */
  async strongBlocks(path: string, headingPath: string, headings: string[], signal?: AbortSignal): Promise<Result[]> {
    const view = await this.related({ kind: "block", path, headingPath, headings }, signal, 20);
    if (view.state !== "ok") return [];
    return view.results.filter((r) => r.label === "strong");
  }
}
