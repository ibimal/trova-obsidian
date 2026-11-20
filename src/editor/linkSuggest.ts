// Semantic link suggestions: typing `[[` ranks notes by relevance to the current block, not only
// by name. Title-lane matches are re-ordered by 0.5 x title rank score + 0.5 x similarity.

import { EditorSuggest, TFile, type Editor, type EditorPosition, type EditorSuggestContext, type EditorSuggestTriggerInfo } from "obsidian";
import { LINK_SUGGEST_SIMILARITY_WEIGHT, LINK_SUGGEST_TITLE_WEIGHT } from "@trova/contract";
import type TrovaPlugin from "../main.js";
import { folderOf } from "../ui.js";

interface Suggestion {
  path: string;
  title: string;
  alias?: string;
  score: number;
  similarity: number;
}

/** Blends the title rank score with the similarity to the current block. Both are 0..1. */
export function rankLinkSuggestions(titles: { path: string; title: string; alias?: string; score: number }[], similarity: Map<string, number>): Suggestion[] {
  const max = Math.max(...titles.map((s) => s.score), 1e-9);
  return titles
    .map((s) => {
      const sim = similarity.get(s.path) ?? 0;
      return { ...s, similarity: sim, score: LINK_SUGGEST_TITLE_WEIGHT * (s.score / max) + LINK_SUGGEST_SIMILARITY_WEIGHT * sim };
    })
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
}

export class LinkSuggest extends EditorSuggest<Suggestion> {
  private blockKey = "";
  private blockSimilarity = new Map<string, number>();
  private blockAt = 0;

  constructor(private plugin: TrovaPlugin) {
    super(plugin.app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    // Without the engine there is no similarity to add, so Obsidian's own suggester handles `[[`.
    if (!file || !this.plugin.engine.has("relatedByVector")) return null;
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    const open = before.lastIndexOf("[[");
    if (open === -1) return null;
    const query = before.slice(open + 2);
    if (/[\]|#^\n]/.test(query) || query.length === 0) return null;
    return { start: { line: cursor.line, ch: open }, end: cursor, query };
  }

  /** Related-to-block similarities, cached for the block being edited. */
  private async similarities(ctx: EditorSuggestContext): Promise<Map<string, number>> {
    const start = Math.max(0, ctx.start.line - 12);
    const text = ctx.editor.getRange({ line: start, ch: 0 }, ctx.start).slice(-2000);
    const key = `${ctx.file?.path}:${start}`;
    if (key === this.blockKey && Date.now() - this.blockAt < 30_000) return this.blockSimilarity;
    if (text.trim().split(/\s+/).length < 8) return new Map();
    try {
      const res = await this.plugin.engine.related({ anchor: { text }, granularity: "source", limit: 50, loose: true, collections: [this.plugin.collection] });
      this.blockSimilarity = new Map(res.results.map((r) => [r.path, r.scores.vec ?? 0]));
      this.blockKey = key;
      this.blockAt = Date.now();
    } catch {
      this.blockSimilarity = new Map();
    }
    return this.blockSimilarity;
  }

  async getSuggestions(ctx: EditorSuggestContext): Promise<Suggestion[]> {
    const [titles, similarity] = await Promise.all([this.plugin.worker.suggest(ctx.query, 40).catch(() => []), this.similarities(ctx)]);
    return rankLinkSuggestions(titles.filter((s) => s.path !== ctx.file?.path), similarity).slice(0, 12);
  }

  renderSuggestion(s: Suggestion, el: HTMLElement): void {
    el.addClass("trova-suggest");
    const head = el.createDiv({ cls: "trova-row-head" });
    head.createSpan({ cls: "trova-row-title", text: s.alias ?? s.title });
    if (s.alias) head.createSpan({ cls: "trova-row-alias", text: s.title });
    if (s.similarity >= 0.45) head.createSpan({ cls: "trova-badge trova-badge-vec", text: `${Math.round(s.similarity * 100)}%` });
    const folder = folderOf(s.path);
    if (folder) el.createDiv({ cls: "trova-row-path", text: folder });
  }

  selectSuggestion(s: Suggestion): void {
    const ctx = this.context;
    if (!ctx) return;
    const file = this.app.vault.getAbstractFileByPath(s.path);
    const link = file instanceof TFile ? this.app.fileManager.generateMarkdownLink(file, ctx.file?.path ?? "", undefined, s.alias) : `[[${s.title}]]`;
    // Obsidian auto-closes `[[` with `]]`; replace the closing pair too when it is there.
    const after = ctx.editor.getRange(ctx.end, { line: ctx.end.line, ch: ctx.end.ch + 2 });
    const end = after === "]]" ? { line: ctx.end.line, ch: ctx.end.ch + 2 } : ctx.end;
    ctx.editor.replaceRange(link, ctx.start, end);
    ctx.editor.setCursor({ line: ctx.start.line, ch: ctx.start.ch + link.length });
  }
}
