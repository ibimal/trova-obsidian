// Saved searches: a fenced `trova` code block renders live results inside a note. Its body is
// a query, plus optional `limit:` and `mode:` lines.

import { MarkdownRenderChild, type MarkdownPostProcessorContext } from "obsidian";
import type { Result } from "@trova/contract";
import { t } from "../i18n/en.js";
import type TrovaPlugin from "../main.js";
import { Lru } from "../state/store.js";
import { folderOf, onOpen, renderHighlighted } from "../ui.js";

export interface SavedSearch {
  query: string;
  limit: number;
  mode: "instant" | "ask";
}

export function parseSavedSearch(source: string): SavedSearch {
  const out: SavedSearch = { query: "", limit: 10, mode: "instant" };
  const queryLines: string[] = [];
  for (const line of source.split("\n")) {
    const m = /^\s*(limit|mode)\s*:\s*(\S+)\s*$/i.exec(line);
    if (m && m[1]!.toLowerCase() === "limit" && /^\d+$/.test(m[2]!)) out.limit = Math.max(1, Math.min(100, Number(m[2])));
    else if (m && m[1]!.toLowerCase() === "mode" && /^(instant|ask)$/i.test(m[2]!)) out.mode = m[2]!.toLowerCase() as "instant" | "ask";
    else if (line.trim()) queryLines.push(line.trim());
  }
  out.query = queryLines.join(" ");
  if (/^\?/.test(out.query)) {
    out.mode = "ask";
    out.query = out.query.replace(/^\?\s*/, "");
  }
  return out;
}

const CACHE_MS = 60_000;

class SavedSearchChild extends MarkdownRenderChild {
  private abort: AbortController | null = null;

  constructor(
    el: HTMLElement,
    private plugin: TrovaPlugin,
    private search: SavedSearch,
    private sourcePath: string,
    private cache: Lru<string, { at: number; results: Result[] }>,
  ) {
    super(el);
  }

  override onload(): void {
    // Live results: re-run when the index changes.
    this.register(
      this.plugin.engine.onEvent((e) => {
        if (e.event === "index.ready") void this.run(true);
      }),
    );
    void this.run(false);
  }

  override onunload(): void {
    this.abort?.abort();
  }

  private async run(force: boolean): Promise<void> {
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    const key = `${this.search.mode}|${this.search.limit}|${this.search.query}`;
    const hit = this.cache.get(key);
    if (hit && !force && Date.now() - hit.at < CACHE_MS) return this.render(hit.results, false);
    if (hit) this.render(hit.results, true);
    else this.containerEl.setText("…");
    let results: Result[] = [];
    try {
      const { api } = this.plugin;
      const stream = this.search.mode === "ask" ? api.ask(this.search.query, { signal: abort.signal, limit: this.search.limit }) : api.search(this.search.query, { signal: abort.signal, limit: this.search.limit });
      for await (const batch of stream) {
        if (abort.signal.aborted) return;
        if (batch.stage !== "vec" || this.search.mode === "ask") results = batch.results.length ? batch.results : results;
        this.render(results, !batch.final);
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      if (!hit) this.containerEl.setText(this.plugin.engine.ready ? (err as Error).message : t("needsEngine"));
      return;
    }
    this.cache.set(key, { at: Date.now(), results });
    this.render(results, false);
  }

  private render(results: Result[], refining: boolean): void {
    const el = this.containerEl;
    el.empty();
    el.addClass("trova-saved");
    const head = el.createDiv({ cls: "trova-saved-head" });
    head.createSpan({ cls: "trova-saved-query", text: `${this.search.mode === "ask" ? "? " : ""}${this.search.query}` });
    if (refining) head.createSpan({ cls: "trova-badge trova-badge-refining", text: t("refining") });
    if (results.length === 0) return void el.createDiv({ cls: "trova-empty", text: t("noMatches") });
    const list = el.createEl("ul");
    for (const r of results.slice(0, this.search.limit)) {
      const li = list.createEl("li");
      const heading = r.block?.headings[r.block.headings.length - 1];
      const link = li.createEl("a", { cls: "internal-link", text: r.title + (heading ? ` › ${heading}` : ""), href: r.path });
      link.dataset["href"] = heading ? `${r.path}#${heading}` : r.path;
      onOpen(link, (where) => void this.plugin.openResult(r, where, this.search.query));
      // Reading view opens any clicked internal link too, which would open the note twice. This
      // list opens the result itself, at the match; hover previews still come from reading view.
      for (const type of ["click", "auxclick"]) link.addEventListener(type, (e) => e.stopPropagation());
      const folder = folderOf(r.path);
      if (folder) li.createSpan({ cls: "trova-row-path", text: ` ${folder}` });
      if (r.snippet) renderHighlighted(li.createDiv({ cls: "trova-row-snippet" }), r.snippet, r.highlights);
    }
    void this.sourcePath;
  }
}

export function savedSearchProcessor(plugin: TrovaPlugin) {
  const cache = new Lru<string, { at: number; results: Result[] }>(100);
  return (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
    const search = parseSavedSearch(source);
    if (!search.query) {
      el.createDiv({ cls: "trova-empty", text: t("instantPlaceholder") });
      return;
    }
    ctx.addChild(new SavedSearchChild(el, plugin, search, ctx.sourcePath, cache));
  };
}
