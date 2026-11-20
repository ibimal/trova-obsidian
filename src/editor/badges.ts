// Inline badges: a small count beside each heading shows how many strong matches that section has.
// Clicking opens a popover of those blocks. Counts load in the background and never block typing.

import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, type MarkdownPostProcessorContext } from "obsidian";
import { onOpen } from "../ui.js";
import type { Result } from "@trova/contract";
import { t } from "../i18n/en.js";
import type TrovaPlugin from "../main.js";
import { sectionAt } from "../views/ConnectionsView.js";

const refresh = StateEffect.define<null>();
const TYPING_QUIET_MS = 1200;

/** Strong-match lists per section, shared by the editor and the reading view. */
export class BadgeStore {
  private results = new Map<string, Result[]>();
  private pending = new Set<string>();
  private queue: { key: string; path: string; headingPath: string; headings: string[] }[] = [];
  private running = false;
  private listeners = new Set<() => void>();
  lastTyped = 0;

  constructor(private plugin: TrovaPlugin) {}

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  invalidate(path?: string): void {
    for (const key of [...this.results.keys()]) if (!path || key.startsWith(`${path}#`)) this.results.delete(key);
    for (const l of this.listeners) l();
  }

  get(path: string, headingPath: string, headings: string[]): Result[] | undefined {
    const key = `${path}#${headingPath}`;
    const hit = this.results.get(key);
    if (hit || this.pending.has(key) || !this.plugin.engine.ready) return hit;
    this.pending.add(key);
    this.queue.push({ key, path, headingPath, headings });
    void this.drain();
    return undefined;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.queue.length > 0) {
      // Background work pauses while the user types.
      while (Date.now() - this.lastTyped < TYPING_QUIET_MS) await new Promise((r) => setTimeout(r, TYPING_QUIET_MS));
      const job = this.queue.shift()!;
      try {
        this.results.set(job.key, await this.plugin.connections.strongBlocks(job.path, job.headingPath, job.headings));
      } catch {
        this.results.set(job.key, []);
      }
      this.pending.delete(job.key);
      for (const l of this.listeners) l();
      await new Promise((r) => setTimeout(r, 30));
    }
    this.running = false;
  }
}

export function showBadgePopover(plugin: TrovaPlugin, anchorEl: HTMLElement, results: Result[]): void {
  document.querySelectorAll(".trova-badge-popover").forEach((el) => el.remove());
  const pop = document.body.createDiv({ cls: "trova-popover trova-badge-popover popover" });
  for (const r of results.slice(0, 12)) {
    const row = pop.createDiv({ cls: "trova-popover-item", attr: { tabindex: "0" } });
    row.createDiv({ cls: "trova-row-title", text: r.title });
    const block = r.blocks?.[0] ?? r;
    if (block.block?.headings.length) row.createDiv({ cls: "trova-row-heading", text: block.block.headings.join(" › ") });
    row.createDiv({ cls: "trova-row-snippet", text: block.snippet.slice(0, 140) });
    onOpen(row, (where) => {
      pop.remove();
      void plugin.openResult(block, where);
    });
  }
  const rect = anchorEl.getBoundingClientRect();
  pop.style.top = `${Math.min(window.innerHeight - 200, rect.bottom + 4)}px`;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - 340, rect.left))}px`;
  const close = (e: MouseEvent) => {
    if (!pop.contains(e.target as Node)) {
      pop.remove();
      document.removeEventListener("mousedown", close, true);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", close, true), 0);
}

class BadgeWidget extends WidgetType {
  constructor(
    private plugin: TrovaPlugin,
    private results: Result[],
  ) {
    super();
  }
  override eq(other: BadgeWidget): boolean {
    return other.results === this.results;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "trova-inline-badge";
    el.textContent = String(this.results.length);
    el.setAttribute("aria-label", `${this.results.length} ${t("strong").toLowerCase()}`);
    el.setAttribute("role", "button");
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showBadgePopover(this.plugin, el, this.results);
    });
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

export function badgeExtension(plugin: TrovaPlugin, store: BadgeStore) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private off: () => void;
      constructor(private view: EditorView) {
        this.decorations = this.build();
        this.off = store.onChange(() => {
          // Dispatching from a store callback must not happen inside an update.
          setTimeout(() => this.view.dom.isConnected && this.view.dispatch({ effects: refresh.of(null) }), 0);
        });
      }
      update(u: ViewUpdate): void {
        if (u.docChanged) store.lastTyped = Date.now();
        if (u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)))) this.decorations = this.build();
      }
      destroy(): void {
        this.off();
      }
      private build(): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        if (!plugin.settings.inlineBadges) return builder.finish();
        const file = this.view.state.field(editorInfoField, false)?.file;
        if (!file || file.extension !== "md") return builder.finish();
        const doc = this.view.state.doc;
        const cache = plugin.app.metadataCache.getFileCache(file);
        const headings = (cache?.headings ?? []).map((h) => ({ heading: h.heading, level: h.level, line: h.position.start.line }));
        const { from, to } = this.view.viewport;
        for (const h of headings) {
          if (h.line + 1 > doc.lines) break;
          const line = doc.line(h.line + 1);
          if (line.to < from || line.from > to) continue;
          // The cache may lag behind an edit; skip lines that are no longer headings.
          if (!/^#{1,6}\s/.test(line.text)) continue;
          const section = sectionAt(headings, h.line);
          const results = store.get(file.path, section.headingPath, section.headings);
          if (results && results.length > 0) builder.add(line.to, line.to, Decoration.widget({ widget: new BadgeWidget(plugin, results), side: 1 }));
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** Badges in reading view. */
export function badgePostProcessor(plugin: TrovaPlugin, store: BadgeStore) {
  return (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
    if (!plugin.settings.inlineBadges) return;
    const file = plugin.app.vault.getFileByPath(ctx.sourcePath);
    if (!file) return;
    const headings = (plugin.app.metadataCache.getFileCache(file)?.headings ?? []).map((h) => ({ heading: h.heading, level: h.level, line: h.position.start.line }));
    el.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6").forEach((hEl) => {
      const info = ctx.getSectionInfo(hEl);
      if (!info) return;
      const section = sectionAt(headings, info.lineStart);
      const paint = (): boolean => {
        const results = store.get(file.path, section.headingPath, section.headings);
        if (!results) return false;
        hEl.querySelector(".trova-inline-badge")?.remove();
        if (results.length === 0) return true;
        const badge = hEl.createSpan({ cls: "trova-inline-badge", text: String(results.length), attr: { role: "button", tabindex: "0" } });
        badge.addEventListener("click", (e) => {
          e.stopPropagation();
          showBadgePopover(plugin, badge, results);
        });
        return true;
      };
      if (!paint()) {
        const off = store.onChange(() => {
          if (!hEl.isConnected || paint()) off();
        });
      }
    });
  };
}
