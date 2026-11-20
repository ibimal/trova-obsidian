// Instant search: a keyboard-first modal that shows ranked results on every keystroke. Keyword
// rows come from the worker and the engine's lex lane; semantic rows join in their own section.

import { Modal, Notice, Platform, TFile, setIcon, type Editor } from "obsidian";
import { findInText, parseQuery, pickAskMode, queryRanges, queryText, type LineMatch } from "@trova/contract";
import { t } from "../i18n/en.js";
import type TrovaPlugin from "../main.js";
import { stableOrder, type InstantState, type Row } from "../query/controller.js";
import { banner, folderOf, linkFor, openIn, quietLabel, renderBadges, renderHighlighted, skeletonAfter, type OpenIn } from "../ui.js";

const MAX_ROWS = 50;
const MAX_INFILE_ROWS = 200;
const HISTORY_KEY = "instant-history";
const HISTORY_MAX = 30;

interface Session {
  raw: string;
  selectedId: string | null;
  at: number;
}

let lastSession: Session | null = null;

interface Item {
  id: string;
  row?: Row;
  /** A plain note row of the empty state. */
  path?: string;
  match?: LineMatch;
  section: "main" | "semantic" | "recent" | "pinned" | "infile" | "ask";
}

/** A shortcut as this platform writes it: ⌘ ⌥ ⇧ on a Mac, Ctrl+ Alt+ Shift+ elsewhere. */
function key(shortcut: string): string {
  return Platform.isMacOS ? shortcut : shortcut.replace("⌘", "Ctrl+").replace("⌥", "Alt+").replace("⇧", "Shift+");
}

/** The id of the "Ask this as a question" row. */
const ASK_ITEM = "ask";

/**
 * True when Instant search should offer "Ask this as a question" above its results: the query
 * has a question's shape by the rule Auto uses to pick Deep (6 or more words, a final "?", or a
 * question word first). A query starting with "?" is already an Ask and is not counted.
 */
export function offersAsk(raw: string): boolean {
  if (!raw.trim() || /^\s*\?/.test(raw)) return false;
  const query = parseQuery(raw).query;
  return queryText(query).trim() !== "" && pickAskMode(query) === "deep";
}

export interface InstantOptions {
  query?: string;
  /** Opens directly in in-file search for this note. */
  inFilePath?: string;
}

export class InstantModal extends Modal {
  private input!: HTMLInputElement;
  private underlay!: HTMLElement;
  private listEl!: HTMLElement;
  private noticeEl!: HTMLElement;
  private liveEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private items: Item[] = [];
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private userMoved = false;
  private state: InstantState | null = null;
  private frame = 0;
  private editor: Editor | null;
  private sourcePath: string;
  private inFile: { path: string; title: string; saved: { raw: string; selectedId: string | null } | null } | null = null;
  private inFileText = "";
  private noFuzzy = false;
  private cancelSkeleton: (() => void) | null = null;
  private uid = `trova-${Math.random().toString(36).slice(2, 8)}`;
  /** Position in the query history while the user walks it with Alt+Up and Alt+Down; -1 is the live query. */
  private historyAt = -1;
  private draft = "";
  /**
   * Which keys the footer names: "normal" for a list of notes; "ask" when "Ask this as a question"
   * is offered beside notes or on the "No matches" screen, so its shortcut is listed too;
   * "askOnly" when a question found no notes and the Ask row is the only thing to act on.
   */
  private hintMode: "normal" | "ask" | "askOnly" = "normal";

  constructor(
    private plugin: TrovaPlugin,
    private opts: InstantOptions = {},
  ) {
    super(plugin.app);
    this.editor = plugin.app.workspace.activeEditor?.editor ?? null;
    this.sourcePath = plugin.app.workspace.getActiveFile()?.path ?? "";
  }

  override onOpen(): void {
    const { modalEl, contentEl } = this;
    modalEl.addClass("trova-modal");
    // The modal sits near the top and grows downward, so the search box stays put as results change.
    this.containerEl.addClass("trova-modal-container");
    if (Platform.isMobile) modalEl.addClass("trova-fullscreen");
    this.titleEl.remove();
    contentEl.empty();

    const bar = contentEl.createDiv({ cls: "trova-querybar" });
    setIcon(bar.createSpan({ cls: "trova-query-icon", attr: { "aria-hidden": "true" } }), "search");
    this.underlay = bar.createDiv({ cls: "trova-underlay", attr: { "aria-hidden": "true" } });
    this.input = bar.createEl("input", {
      cls: "trova-input",
      attr: { type: "text", role: "combobox", "aria-expanded": "true", "aria-controls": `${this.uid}-list`, "aria-autocomplete": "list", spellcheck: "false", placeholder: t("instantPlaceholder") },
    });
    quietLabel(this.input, t("cmdInstant"));
    this.noticeEl = contentEl.createDiv({ cls: "trova-notices" });
    this.listEl = contentEl.createDiv({ cls: "trova-list", attr: { role: "listbox", id: `${this.uid}-list` } });
    quietLabel(this.listEl, t("cmdInstant"));
    this.liveEl = contentEl.createDiv({ cls: "trova-live", attr: { "aria-live": "polite", role: "status" } });
    this.hintEl = contentEl.createDiv({ cls: "trova-hints" });

    this.input.addEventListener("input", () => {
      this.userMoved = false;
      this.noFuzzy = false;
      this.historyAt = -1;
      this.onQuery();
    });
    this.scope.register(["Alt"], "ArrowUp", (e) => this.walkHistory(1, e));
    this.scope.register(["Alt"], "ArrowDown", (e) => this.walkHistory(-1, e));
    this.input.addEventListener("scroll", () => (this.underlay.scrollLeft = this.input.scrollLeft));
    this.scope.register([], "ArrowDown", (e) => this.move(1, e));
    this.scope.register([], "ArrowUp", (e) => this.move(-1, e));
    this.scope.register(["Ctrl"], "n", (e) => this.move(1, e));
    this.scope.register(["Ctrl"], "p", (e) => this.move(-1, e));
    this.scope.register(["Ctrl"], "j", (e) => (this.plugin.settings.vimKeys ? this.move(1, e) : undefined));
    this.scope.register(["Ctrl"], "k", (e) => (this.plugin.settings.vimKeys ? this.move(-1, e) : undefined));
    // Open keys follow Obsidian's rule: Mod for a new tab, Mod+Alt for a split, Mod+Alt+Shift for a window.
    this.scope.register([], "Enter", (e) => this.act("open", e));
    this.scope.register(["Mod"], "Enter", (e) => this.act("open", e, "tab"));
    this.scope.register(["Mod", "Alt"], "Enter", (e) => this.act("open", e, "split"));
    this.scope.register(["Mod", "Alt", "Shift"], "Enter", (e) => this.act("open", e, "window"));
    this.scope.register(["Alt"], "Enter", (e) => this.act("link", e));
    this.scope.register(["Shift"], "Enter", (e) => this.act("create", e));
    this.scope.register(["Mod", "Shift"], "Enter", (e) => {
      e.preventDefault();
      if (!this.inFile && this.input.value.trim()) this.askNow();
      return false;
    });
    this.scope.register(["Mod"], "b", (e) => this.act("basket", e));
    this.scope.register([], "Tab", (e) => {
      e.preventDefault();
      const item = this.selected();
      const path = item?.row?.path ?? item?.path;
      if (!this.inFile && path && path.endsWith(".md") && (!item?.row || item.row.collection === this.plugin.collection)) void this.enterInFile(path, true);
      return false;
    });
    this.scope.register([], "Escape", () => {
      if (this.inFile?.saved) {
        this.leaveInFile();
        return false;
      }
      this.close();
      return false;
    });

    if (this.opts.inFilePath) {
      void this.enterInFile(this.opts.inFilePath, false);
    } else {
      const restore = this.plugin.settings.restoreQuery && lastSession && Date.now() - lastSession.at < this.plugin.settings.restoreQuerySeconds * 1000;
      const initial = this.opts.query ?? (restore ? lastSession!.raw : "");
      if (this.opts.query === undefined && restore) this.selectedId = lastSession!.selectedId;
      this.input.value = initial;
      if (initial) this.input.select();
      this.onQuery();
    }
    this.renderHints();
    this.input.focus();
  }

  override onClose(): void {
    this.plugin.controller.cancel();
    cancelAnimationFrame(this.frame);
    this.cancelSkeleton?.();
    if (!this.inFile || this.inFile.saved) {
      const raw = this.inFile?.saved ? this.inFile.saved.raw : this.input.value;
      lastSession = { raw, selectedId: this.inFile?.saved ? this.inFile.saved.selectedId : this.selectedId, at: Date.now() };
    }
    this.contentEl.empty();
  }

  // ---------- history ----------

  private history(): string[] {
    const stored = this.plugin.local.get<unknown>(HISTORY_KEY);
    return Array.isArray(stored) ? stored.filter((q): q is string => typeof q === "string") : [];
  }

  /** A query joins the history when the user acts on one of its results. */
  private remember(): void {
    const raw = (this.inFile?.saved ? this.inFile.saved.raw : this.inFile ? "" : this.input.value).trim();
    if (!raw) return;
    this.plugin.local.set(HISTORY_KEY, [raw, ...this.history().filter((q) => q !== raw)].slice(0, HISTORY_MAX));
  }

  private walkHistory(step: number, e: KeyboardEvent): false {
    e.preventDefault();
    if (this.inFile) return false;
    const history = this.history();
    const next = Math.max(-1, Math.min(history.length - 1, this.historyAt + step));
    if (next === this.historyAt) return false;
    if (this.historyAt === -1) this.draft = this.input.value;
    this.historyAt = next;
    this.input.value = next === -1 ? this.draft : history[next]!;
    this.userMoved = false;
    this.onQuery();
    return false;
  }

  // ---------- query ----------

  private onQuery(): void {
    const raw = this.input.value;
    if (this.inFile) {
      this.renderInFile();
      return;
    }
    this.renderUnderlay();
    if (!raw.trim()) {
      this.plugin.controller.cancel();
      this.state = null;
      this.showEmptyState();
      return;
    }
    if (/^\s*\?/.test(raw)) {
      this.plugin.controller.cancel();
      this.state = null;
      this.items = [];
      this.listEl.empty();
      this.noticeEl.empty();
      this.listEl.createDiv({ cls: "trova-empty", text: `↵ ${t("cmdAsk")}: ${raw.replace(/^\s*\?\s*/, "")}` });
      this.setHintMode("normal");
      return;
    }
    this.cancelSkeleton?.();
    let arrived = false;
    this.cancelSkeleton = skeletonAfter(this.listEl, () => !arrived && this.items.length === 0);
    this.plugin.controller.run(
      raw,
      (state) => {
        arrived = true;
        this.state = state;
        // One render per animation frame, however many lanes arrive in it.
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => this.renderResults());
      },
      { noFuzzy: this.noFuzzy },
    );
  }

  /** Underlines unknown operators and bad filter values; the tooltip names the problem. */
  private renderUnderlay(): void {
    const raw = this.input.value;
    this.underlay.empty();
    const { diagnostics } = this.plugin.controller.parse(raw);
    let at = 0;
    for (const d of diagnostics) {
      if (d.start < at) continue;
      this.underlay.appendText(raw.slice(at, d.start));
      const span = this.underlay.createSpan({ cls: "trova-squiggle", text: raw.slice(d.start, d.end) });
      span.setAttr("aria-label", d.message);
      span.setAttr("title", d.message);
      at = d.end;
    }
    this.underlay.appendText(raw.slice(at));
    this.input.setAttr("aria-invalid", diagnostics.length ? "true" : "false");
    this.input.setAttr("title", diagnostics.map((d) => d.message).join("\n"));
  }

  private showEmptyState(): void {
    const { app, local } = this.plugin;
    const items: Item[] = [];
    const seen = new Set<string>();
    for (const path of local.recentPaths(12)) {
      if (app.vault.getAbstractFileByPath(path) instanceof TFile && !this.plugin.indexer.isExcluded(path)) {
        items.push({ id: `recent:${path}`, path, section: "recent" });
        seen.add(path);
      }
    }
    for (const path of this.plugin.bookmarkedPaths()) {
      if (!seen.has(path)) items.push({ id: `pinned:${path}`, path, section: "pinned" });
    }
    this.items = items;
    this.setHintMode("normal");
    this.noticeEl.empty();
    this.renderList();
  }

  private renderResults(): void {
    const state = this.state;
    if (!state || this.inFile) return;
    const prev = this.items.filter((i) => i.section === "main").map((i) => i.id);
    const locked = this.userMoved ? this.selectedId : this.hoveredId;
    const byId = new Map(state.rows.map((r) => [r.id, r]));
    const order = stableOrder(prev, state.rows.slice(0, MAX_ROWS).map((r) => r.id), locked);
    const items: Item[] = order.map((id) => ({ id, row: byId.get(id)!, section: "main" as const }));
    for (const row of state.semantic) items.push({ id: row.id, row, section: "semantic" });
    // A question-like query also offers Ask, above the notes. When it finds no notes at all, the
    // Ask row is all the list shows, selected, so Enter asks. Any other query with no notes gets
    // the "No matches" screen, whose buttons show their shortcuts.
    const question = offersAsk(this.input.value);
    let mode: "normal" | "ask" | "askOnly" = "normal";
    if (items.length > 0 && question) {
      items.unshift({ id: ASK_ITEM, section: "ask" });
      mode = "ask";
    } else if (items.length === 0 && !state.pending) {
      if (question) items.push({ id: ASK_ITEM, section: "ask" });
      mode = question ? "askOnly" : "ask";
    }
    this.items = items;
    this.setHintMode(mode);

    this.noticeEl.empty();
    if (state.correction) {
      const line = this.noticeEl.createDiv({ cls: "trova-correction" });
      line.appendText(t("correctionShown"));
      line.createEl("em", { text: state.correction.to });
      line.appendText(t("correctionInstead"));
      const link = line.createEl("a", { text: state.correction.from, href: "#" });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        this.noFuzzy = true;
        this.onQuery();
      });
    }
    const pct = this.plugin.indexedPercent();
    if (pct < 100) banner(this.noticeEl, t("indexPartial", { pct }));
    this.renderList(state.pending || state.refining);
    if (!state.pending) {
      const n = this.items.filter((i) => i.section !== "ask").length;
      this.liveEl.setText(n === 0 ? t("noMatches") : n === 1 ? t("resultCountOne") : t("resultsCount", { n }));
    }
  }

  // ---------- list ----------

  private selected(): Item | undefined {
    return this.items.find((i) => i.id === this.selectedId);
  }

  private renderList(pending = false): void {
    this.cancelSkeleton?.();
    const list = this.listEl;
    const scroll = list.scrollTop;
    list.empty();
    // The first note is selected, never the Ask row, so Enter keeps opening the top result. The
    // Ask row is selected only when it is alone, or when the user moved to it.
    const firstNote = this.items.find((i) => i.section !== "ask");
    if (!this.items.some((i) => i.id === this.selectedId) || (this.selectedId === ASK_ITEM && !this.userMoved && firstNote)) {
      this.selectedId = (firstNote ?? this.items[0])?.id ?? null;
    }
    const askOnly = this.items.length === 1 && this.items[0]!.section === "ask";
    if (askOnly) list.createDiv({ cls: "trova-ask-empty-note", text: t("noNotesAllWords") });

    if (this.items.length === 0) {
      if (pending) return;
      if (this.inFile) list.createDiv({ cls: "trova-empty", text: this.input.value.trim() ? t("noMatchesInFile") : "" });
      else if (this.input.value.trim()) this.renderNoResults(list);
      this.input.removeAttribute("aria-activedescendant");
      return;
    }
    let section = "";
    this.items.forEach((item, index) => {
      if (item.section !== section) {
        section = item.section;
        const title = section === "semantic" ? t("relatedByMeaning") : section === "recent" ? t("recent") : section === "pinned" ? t("pinned") : "";
        if (title) list.createDiv({ cls: "trova-section", text: title, attr: { role: "presentation" } });
      }
      const el = list.createDiv({ cls: "trova-row", attr: { role: "option", id: `${this.uid}-opt-${index}`, "aria-selected": String(item.id === this.selectedId) } });
      if (item.id === this.selectedId) el.addClass("is-selected");
      el.dataset["id"] = item.id;
      if (item.section === "ask") this.renderAsk(el);
      else if (item.match) this.renderMatch(el, item.match);
      else if (item.row) this.renderRow(el, item.row);
      else this.renderPlain(el, item.path!);
      el.addEventListener("mouseenter", () => (this.hoveredId = item.id));
      el.addEventListener("mouseleave", () => {
        if (this.hoveredId === item.id) this.hoveredId = null;
      });
      el.addEventListener("click", (e) => {
        this.selectedId = item.id;
        const where = openIn(e);
        this.act(!where && e.altKey ? "link" : "open", e, where);
      });
      el.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault());
      el.addEventListener("auxclick", (e) => {
        if (e.button !== 1) return;
        this.selectedId = item.id;
        this.act("open", e, "tab");
      });
    });
    if (askOnly) {
      const create = list.createDiv({ cls: "trova-ask-empty-actions" });
      const button = create.createEl("button", { cls: "trova-link-button" });
      button.appendText(t("createNote"));
      button.createEl("kbd", { text: key("⇧↵"), attr: { "aria-hidden": "true" } });
      button.addEventListener("click", () => void this.createNote());
    }
    list.scrollTop = scroll;
    this.syncSelection(false);
  }

  private renderRow(el: HTMLElement, row: Row): void {
    const head = el.createDiv({ cls: "trova-row-head" });
    renderHighlighted(head.createSpan({ cls: "trova-row-title" }), row.title, row.titleHighlights);
    if (row.alias) head.createSpan({ cls: "trova-row-alias", text: row.alias });
    const folder = folderOf(row.path);
    const where = row.collection !== this.plugin.collection ? `${row.collection}: ${folder}` : folder;
    if (where) head.createSpan({ cls: "trova-row-path", text: where });
    renderBadges(head.createSpan({ cls: "trova-badges" }), row.matchedBy, row.type);
    if (row.headings.length) el.createDiv({ cls: "trova-row-heading", text: row.headings.join(" › ") });
    if (row.snippet) renderHighlighted(el.createDiv({ cls: "trova-row-snippet" }), row.snippet, row.highlights);
    if (row.context) el.createDiv({ cls: "trova-row-context", text: row.context });
  }

  /** "Ask this as a question": runs the query as a question in the Connections and Ask panel. */
  private renderAsk(el: HTMLElement): void {
    el.addClass("trova-ask-row");
    setIcon(el.createSpan({ cls: "trova-ask-row-icon", attr: { "aria-hidden": "true" } }), "message-circle-question");
    const text = el.createDiv({ cls: "trova-ask-row-text" });
    text.createDiv({ cls: "trova-row-title", text: t("askAsQuestion") });
    text.createDiv({ cls: "trova-row-path", text: t("askRowDetail") });
    el.createEl("kbd", { cls: "trova-ask-row-key", text: key("⌘⇧↵"), attr: { "aria-hidden": "true" } });
  }

  /** Closes Instant search and runs its query as a question in the panel. */
  private askNow(): void {
    const raw = this.input.value;
    this.close();
    void this.plugin.openAsk(queryText(parseQuery(raw).query) || raw);
  }

  private setHintMode(mode: "normal" | "ask" | "askOnly"): void {
    if (mode === this.hintMode) return;
    this.hintMode = mode;
    this.renderHints();
  }

  private renderPlain(el: HTMLElement, path: string): void {
    const head = el.createDiv({ cls: "trova-row-head" });
    head.createSpan({ cls: "trova-row-title", text: path.split("/").pop()!.replace(/\.md$/, "") });
    const folder = folderOf(path);
    if (folder) head.createSpan({ cls: "trova-row-path", text: folder });
  }

  private renderMatch(el: HTMLElement, match: LineMatch): void {
    el.addClass("trova-row-infile");
    el.createSpan({ cls: "trova-line-no", text: String(match.line + 1) });
    renderHighlighted(el.createDiv({ cls: "trova-row-snippet trova-pre" }), match.context, match.highlights);
  }

  private renderNoResults(list: HTMLElement): void {
    const box = list.createDiv({ cls: "trova-empty" });
    box.createDiv({ text: t("noMatches") });
    const buttons = box.createDiv({ cls: "trova-empty-actions" });
    // Each button shows the key that does the same, so the shortcut is learnt where it is used.
    const withKey = (text: string, shortcut: string) => {
      const b = buttons.createEl("button");
      b.appendText(text);
      b.createEl("kbd", { text: key(shortcut), attr: { "aria-hidden": "true" } });
      return b;
    };
    withKey(t("askAsQuestion"), "⌘⇧↵").addEventListener("click", () => this.askNow());
    if (this.state && this.state.query.filters.length > 0) {
      buttons.createEl("button", { text: t("removeFilters") }).addEventListener("click", () => {
        this.input.value = [queryText(this.state!.query), ...this.state!.query.mustNot.map((m) => `-${m.text}`)].join(" ").trim();
        this.onQuery();
        this.input.focus();
      });
    }
    withKey(t("createNote"), "⇧↵").addEventListener("click", () => void this.createNote());
  }

  private syncSelection(scroll = true): void {
    let active: HTMLElement | null = null;
    this.listEl.querySelectorAll<HTMLElement>(".trova-row").forEach((el) => {
      const on = el.dataset["id"] === this.selectedId;
      el.toggleClass("is-selected", on);
      el.setAttr("aria-selected", String(on));
      if (on) active = el;
    });
    const el = active as HTMLElement | null;
    if (el) {
      this.input.setAttr("aria-activedescendant", el.id);
      if (scroll) el.scrollIntoView({ block: "nearest" });
    }
  }

  private move(delta: number, e: KeyboardEvent): false {
    e.preventDefault();
    if (this.items.length === 0) return false;
    const at = Math.max(0, this.items.findIndex((i) => i.id === this.selectedId));
    const next = (at + delta + this.items.length) % this.items.length;
    this.selectedId = this.items[next]!.id;
    this.userMoved = true;
    this.syncSelection();
    return false;
  }

  private renderHints(): void {
    this.hintEl.empty();
    // Only the keys that do something here: with no note to act on, the note keys are left out.
    const hints: [string, string][] = this.inFile
      ? [["↵", t("hintOpen")], ["esc", t("hintBack")]]
      : this.hintMode === "askOnly"
        ? [["↵", t("hintAsk")], ["⇧↵", t("hintCreate")], ["⌥↑", t("cmdHistoryPrev")], ["esc", t("hintClose")]]
        : [["↵", t("hintOpen")], ["⌘↵", t("hintNewTab")], ...(this.hintMode === "ask" ? ([["⌘⇧↵", t("hintAsk")]] as [string, string][]) : []), ["⌥↵", t("hintInsertLink")], ["⇧↵", t("hintCreate")], ["tab", t("hintInFile")], ["⌘B", t("hintBasket")], ["⌥↑", t("cmdHistoryPrev")]];
    for (const [shortcut, label] of hints) {
      const hint = this.hintEl.createSpan({ cls: "trova-hint" });
      hint.createEl("kbd", { text: key(shortcut) });
      hint.appendText(` ${label}`);
    }
  }

  // ---------- in-file search ----------

  private async enterInFile(path: string, fromResults: boolean): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    this.plugin.controller.cancel();
    const saved = fromResults ? { raw: this.input.value, selectedId: this.selectedId } : null;
    this.inFile = { path, title: file.basename, saved };
    this.inFileText = await this.app.vault.cachedRead(file);
    // The words of the result query carry over, without filters.
    this.input.value = fromResults ? queryText(parseQuery(saved!.raw).query) : (this.opts.query ?? "");
    this.input.placeholder = t("inFilePlaceholder", { title: file.basename });
    this.underlay.empty();
    this.noticeEl.empty();
    banner(this.noticeEl, file.path);
    this.selectedId = null;
    this.renderHints();
    this.renderInFile();
    this.input.focus();
  }

  private leaveInFile(): void {
    const saved = this.inFile!.saved!;
    this.inFile = null;
    this.input.value = saved.raw;
    this.input.placeholder = t("instantPlaceholder");
    this.selectedId = saved.selectedId;
    this.userMoved = true;
    this.renderHints();
    this.onQuery();
  }

  private renderInFile(): void {
    const query = parseQuery(this.input.value).query;
    const matches = this.input.value.trim() ? findInText(this.inFileText, query) : [];
    // A long note can match hundreds of lines; the list shows the first 200.
    this.items = matches.slice(0, MAX_INFILE_ROWS).map((match) => ({ id: `m:${match.offset}`, match, section: "infile" as const }));
    this.renderList();
    if (matches.length > MAX_INFILE_ROWS) this.listEl.createDiv({ cls: "trova-section", text: `+${matches.length - MAX_INFILE_ROWS}` });
    this.liveEl.setText(matches.length === 1 ? t("resultCountOne") : t("resultsCount", { n: matches.length }));
  }

  // ---------- actions ----------

  /** Runs a row action; `where` says where "open" opens: the current tab, or a new tab, split or window. */
  private act(action: "open" | "link" | "create" | "basket", e: Event, where: OpenIn = false): false {
    e.preventDefault();
    const raw = this.input.value;
    if (action === "create") {
      void this.createNote();
      return false;
    }
    if (!this.inFile && /^\s*\?/.test(raw)) {
      this.close();
      void this.plugin.openAsk(raw.replace(/^\s*\?\s*/, ""));
      return false;
    }
    const item = this.selected();
    if (!item) return false;
    if (item.section === "ask") {
      // The Ask row only asks: every open key runs the question; link and basket do nothing.
      if (action === "open") this.askNow();
      return false;
    }
    this.remember();
    if (item.match && this.inFile) {
      // Enter scrolls the editor to the match; the modal keeps its state for Esc-back.
      const range = queryRanges(this.inFileText, parseQuery(raw).query).find((r) => r[0] === item.match!.offset);
      const length = range ? range[1] - range[0] : 1;
      void this.plugin.open({ path: this.inFile.path, offset: item.match.offset, length }, where);
      if (!this.inFile.saved) this.close();
      return false;
    }
    const path = item.row?.path ?? item.path!;
    const headings = item.row?.headings ?? [];
    if (action === "basket") {
      const block = item.row?.blockId && headings.length ? { headingPath: item.row.blockId.slice(item.row.id.length + 1), headings } : undefined;
      new Notice(this.plugin.basket.add(path, block) ? t("addedToBasket") : t("alreadyInBasket"));
      return false;
    }
    if (action === "link") {
      if (!this.editor) {
        new Notice(t("noEditor"));
        return false;
      }
      this.editor.replaceSelection(linkFor(this.app, path, headings[headings.length - 1], this.sourcePath));
      this.close();
      return false;
    }
    this.close();
    void this.openRow(item, where);
    return false;
  }

  private async openRow(item: Item, where: OpenIn): Promise<void> {
    const row = item.row;
    if (!row) {
      await this.plugin.open({ path: item.path! }, where);
      return;
    }
    const root = this.plugin.rootOf(row.collection);
    let offset = row.offset;
    let length: number | undefined;
    if (!root && row.path.endsWith(".md") && this.state) {
      // Flash the first match inside the matched block.
      const file = this.app.vault.getAbstractFileByPath(row.path);
      if (file instanceof TFile) {
        const content = await this.app.vault.cachedRead(file);
        const ranges = queryRanges(content, this.state.query);
        const hit = ranges.find((r) => offset === undefined || r[0] >= offset) ?? ranges[0];
        if (hit && row.matchedBy.some((m) => m === "lex" || m === "fuzzy")) {
          offset = hit[0];
          length = hit[1] - hit[0];
        }
      }
    }
    await this.plugin.open({ path: row.path, root, headings: row.headings, offset, length }, where);
  }

  private async createNote(): Promise<void> {
    const name = (queryText(parseQuery(this.input.value).query) || this.input.value).replace(/[\\/:*?"<>|#^[\]]/g, " ").trim();
    if (!name) return;
    this.close();
    const folder = this.app.fileManager.getNewFileParent(this.sourcePath);
    const path = `${folder.path === "/" ? "" : `${folder.path}/`}${name}.md`;
    const existing = this.app.vault.getAbstractFileByPath(path);
    const file = existing instanceof TFile ? existing : await this.app.vault.create(path, "");
    await this.app.workspace.getLeaf(false).openFile(file);
  }
}
