// The Connections pane: one sidebar pane for "what relates to what I am working on" and "ask my
// vault". With an empty search box it lists the notes related to the active note, section or
// selection, and the notes that mention it without a link. A typed question replaces that list
// with answers; Esc or "Related notes" goes back. A resizable drawer at the bottom shows the
// similarity graph of the same note, with its selection kept in step with the list.

import { ItemView, Keymap, MarkdownView, Notice, Platform, TFile, debounce, setIcon, type WorkspaceLeaf } from "obsidian";
import { parseId, slugHeading, type DuplicatePair, type DuplicatesResponse, type Filter, type Result } from "@trova/contract";
import type { Anchor, RelatedView } from "../features/connections.js";
import { confirmLinkAll, findMentions, linkMentions, mentionCount } from "../features/mentions.js";
import { t } from "../i18n/en.js";
import type TrovaPlugin from "../main.js";
import { banner, folderOf, isLinkKey, linkFor, onOpen, openIn, passEnterKeys, quietLabel, renderHighlighted, showMenu, skeletonAfter, undoNotice, type OpenIn } from "../ui.js";
import type { MentionHit } from "../worker/index.js";
import { ASK_ANSWERS, AskSession, shiftHighlights, stripHeading, type AskMode, type RowWiring } from "./askSession.js";
import { GRAPH_SIZES } from "./GraphView.js";
import { moveFocus, renderMeter } from "./rows.js";
import { storedBoolean, storedNumber } from "../state/sanitize.js";
import { SimilarityGraph } from "./similarityGraph.js";

export const CONNECTIONS_VIEW = "trova-connections";
type AnchorKind = "note" | "block" | "selection";

/** The graph drawer is never shorter than this, and leaves at least `LIST_MIN` for the list. */
export const DRAWER_MIN = 120;
const LIST_MIN = 180;
/** With no saved choice, the drawer starts open in a pane at least this tall. */
const DRAWER_AUTO_OPEN = 640;
/** The drawer shows this many related notes unless the user picks another size. */
const DRAWER_LIMIT = 12;
/** The near-duplicate pairs are read again after this long. */
const DUPLICATES_TTL_MS = 60_000;

/** The heading path of the section that contains a line, from the metadata cache's headings. */
export function sectionAt(headings: { heading: string; level: number; line: number }[], line: number): { headingPath: string; headings: string[] } {
  const stack: { level: number; text: string }[] = [];
  const seen = new Map<string, number>();
  let current = { headingPath: "", headings: [] as string[] };
  for (const h of headings) {
    while (stack.length && stack[stack.length - 1]!.level >= h.level) stack.pop();
    stack.push({ level: h.level, text: h.heading });
    const texts = stack.map((s) => s.text);
    let path = texts.map(slugHeading).join("/");
    const count = (seen.get(path) ?? 0) + 1;
    seen.set(path, count);
    if (count > 1) path = `${path}~${count}`;
    if (h.line <= line) current = { headingPath: path, headings: texts };
    else break;
  }
  return current;
}

/** The most similar near-duplicate of a note from the last scan, or null. Pairs inside one note do not count. */
/**
 * The most similar near-duplicate pair for the scope, from the vault-wide scan. Without
 * `headingPath` (the Note scope) only whole-note pairs count; with it (the Section scope) only
 * pairs that contain that section of the note. `ownId` is this note's side of the pair.
 */
export function duplicateOf(pairs: DuplicatePair[], path: string, headingPath?: string): { pair: DuplicatePair; ownId: string; otherId: string; otherTitle: string } | null {
  let best: DuplicatePair | null = null;
  for (const p of pairs) {
    if (p.aPath === p.bPath || (p.aPath !== path && p.bPath !== path)) continue;
    const ownId = p.aPath === path ? p.a : p.b;
    const fits = headingPath === undefined ? p.kind === "source" : p.kind === "block" && parseId(ownId)?.headingPath === headingPath;
    if (!fits) continue;
    if (!best || p.similarity > best.similarity) best = p;
  }
  if (!best) return null;
  return best.aPath === path ? { pair: best, ownId: best.a, otherId: best.b, otherTitle: best.bTitle } : { pair: best, ownId: best.b, otherId: best.a, otherTitle: best.aTitle };
}

/** How many shared keywords, links and tags the reason line names before "+N". */
const REASON_KEYWORDS = 3;
const REASON_LINKS = 1;
const REASON_TAGS = 2;

/**
 * The reason line of an expanded related note: the similarity, then the keywords, links and tags
 * the two notes share. Long lists end in "+N"; `full` holds every item for the tooltip. Null when
 * the engine sent nothing to show.
 */
export function reasonParts(r: Pick<Result, "scores" | "why">): { score: string; rest: string[]; full: string } | null {
  const name = (path: string) => path.split("/").pop()!.replace(/\.md$/, "");
  const cut = (items: string[], n: number) => (items.length > n ? `${items.slice(0, n).join(", ")} +${items.length - n}` : items.join(", "));
  const keywords = r.why?.keywords ?? [];
  const links = (r.why?.links ?? []).map(name);
  const tags = (r.why?.tags ?? []).map((tag) => `#${tag}`);
  const score = r.scores.vec === undefined ? "" : t("similarity", { pct: Math.round(r.scores.vec * 100) });
  const rest: string[] = [];
  if (keywords.length) rest.push(t("reasonShares", { list: cut(keywords, REASON_KEYWORDS) }));
  if (links.length) rest.push(t("reasonLinks", { list: cut(links, REASON_LINKS) }));
  if (tags.length) rest.push(cut(tags, REASON_TAGS));
  if (!score && rest.length === 0) return null;
  const full = [score, keywords.length ? t("reasonShares", { list: keywords.join(", ") }) : "", links.length ? t("reasonLinks", { list: links.join(", ") }) : "", tags.join(" ")].filter(Boolean).join(" · ");
  return { score, rest, full };
}

/** Keeps a drawer height inside the pane: at least `DRAWER_MIN`, and room for the list above it. */
export function clampDrawer(height: number, pane: number): number {
  return Math.round(Math.max(DRAWER_MIN, Math.min(height, pane - LIST_MIN)));
}

export class ConnectionsView extends ItemView {
  private kind: AnchorKind = "note";
  private anchor: Anchor | null = null;
  /**
   * The last text selected in Selection mode. Switching to Note or Section and back shows it again
   * when the open note has no selection; selecting new text replaces it, and Clear selection or
   * deleting its note forgets it. Kept in memory only.
   */
  private lastSelection: { path: string; text: string } | null = null;
  /** True when the selection's note no longer contains the selected text; the context line marks it. */
  private selectionGone = false;
  /** Whether the context line shows the selection's note link, so a note switch redraws it only on a change. */
  private sourceShown = false;
  private view: RelatedView | null = null;
  /** Locked: the pane keeps its anchor while the user opens other notes. */
  private locked = false;
  private expanded = new Set<string>();
  private allExpanded = false;
  private abort: AbortController | null = null;
  private loading = false;
  private ask: AskSession;
  private selectedPath: string | null = null;
  private mentions: { path: string; hits: MentionHit[] } | null = null;
  private mentionsAbort: AbortController | null = null;
  private duplicates: { at: number; data: DuplicatesResponse } | null = null;

  private inputEl!: HTMLTextAreaElement;
  private clearEl!: HTMLElement;
  private modeEl!: HTMLButtonElement;
  private barEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private hintsEl!: HTMLElement;
  private drawerEl!: HTMLElement;
  private handleEl!: HTMLElement;
  private drawerHeadEl!: HTMLElement;
  private drawerBodyEl!: HTMLElement;
  private graph: SimilarityGraph | null = null;
  private drawerOpen = false;
  private drawerHeight = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: TrovaPlugin,
  ) {
    super(leaf);
    this.ask = new AskSession(plugin, {
      listEl: () => this.bodyEl,
      changed: () => this.render(),
      wireRow: (el, wiring) => this.wireRow(el, wiring),
      selectedPath: () => this.selectedPath,
    });
  }

  getViewType(): string {
    return CONNECTIONS_VIEW;
  }
  getDisplayText(): string {
    return t("connectionsTitle");
  }
  override getIcon(): string {
    return "waypoints";
  }

  override async onOpen(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.addClass("trova-pane", "trova-seek");
    passEnterKeys(this);
    const header = el.createDiv({ cls: "trova-seek-header" });
    this.buildSearch(header);
    this.barEl = header.createDiv({ cls: "trova-seek-bar" });
    this.statusEl = el.createDiv({ cls: "trova-notices", attr: { "aria-live": "polite" } });
    this.bodyEl = el.createDiv({ cls: "trova-pane-body trova-seek-body" });
    this.buildDrawer(el);
    this.hintsEl = el.createDiv({ cls: "trova-hints trova-seek-hints", attr: { "aria-hidden": "true" } });
    const mod = Platform.isMacOS ? "⌘" : "Ctrl+";
    const alt = Platform.isMacOS ? "⌥" : "Alt+";
    for (const [key, text] of [["↑↓", t("hintMove")], ["↵", t("hintOpen")], [`${mod}↵`, t("hintNewTab")], [`${alt}↵`, t("hintInsertLink")], ["esc", t("hintBack")]] as const) {
      const hint = this.hintsEl.createSpan({ cls: "trova-hint" });
      hint.createEl("kbd", { text: key });
      hint.appendText(` ${text}`);
    }

    // "/" anywhere in the pane, outside a text field, goes to the search box.
    this.registerDomEvent(el, "keydown", (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
        e.preventDefault();
        this.focusInput();
      }
    });

    const onSwitch = debounce(() => {
      // A selection stays whatever the refresh setting; only its note link may come or go.
      if (this.kind === "selection") this.syncSourceLink();
      else if (this.plugin.settings.connectionsRefresh !== "manual") this.followActive();
    }, 300, true);
    const onCursor = debounce(() => {
      if (this.kind === "block") this.followActive();
      else if (this.kind === "selection") this.followSelection();
    }, 500, true);
    const onIdle = debounce(() => this.plugin.settings.connectionsRefresh === "idle" && void this.refresh(true), 2500, true);
    this.registerEvent(this.app.workspace.on("file-open", onSwitch));
    this.registerEvent(this.app.workspace.on("active-leaf-change", onSwitch));
    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        onCursor();
        onIdle();
      }),
    );
    this.registerEvent(this.app.workspace.on("css-change", () => this.graph?.refreshTheme()));
    // When the selection's note is saved or deleted, check that the selected text is still there.
    const recheck = (file: { path: string }) => {
      if (this.anchor?.kind === "selection" && file.path === this.anchor.path) void this.checkSelectionText();
    };
    this.registerEvent(this.app.vault.on("modify", recheck));
    this.registerEvent(this.app.vault.on("delete", recheck));
    // A selection follows its note when the note is renamed.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.lastSelection?.path === oldPath) this.lastSelection = { ...this.lastSelection, path: file.path };
        if (this.anchor?.kind === "selection" && this.anchor.path === oldPath) {
          this.anchor = { ...this.anchor, path: file.path };
          this.renderBar();
        }
      }),
    );
    this.registerDomEvent(document, "selectionchange", onCursor);
    this.register(this.plugin.engine.onChange(() => this.onEngineChange()));
    this.register(
      this.plugin.engine.onEvent((e) => {
        if (e.event === "index.ready") this.graph?.clearCache();
        if (e.event === "index.ready" || (e.event === "results.stale" && this.anchor && (e.data["sources"] as string[] | undefined)?.includes(this.plugin.sourceId(this.anchor.path)))) {
          void this.refresh(true);
        }
      }),
    );
    this.register(
      this.plugin.store.onChange(() => {
        this.applyCached();
        this.graph?.relabel();
      }),
    );
    this.followActive();
    // The drawer's first state needs the pane's real height, which exists after layout.
    window.requestAnimationFrame(() => {
      this.restoreDrawer();
      this.clearStatusBar();
    });
    const observer = new ResizeObserver(() => this.clearStatusBar());
    observer.observe(el);
    this.register(() => observer.disconnect());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.clearStatusBar()));
  }

  override async onClose(): Promise<void> {
    this.abort?.abort();
    this.mentionsAbort?.abort();
    this.ask.dispose();
    this.graph?.destroy();
    this.graph = null;
  }

  private lastReady = false;
  private onEngineChange(): void {
    const ready = this.plugin.engine.ready;
    if (ready !== this.lastReady) {
      this.lastReady = ready;
      void this.refresh(true);
      if (this.drawerOpen) void this.graph?.load(this.anchor?.path ?? null, true);
    } else this.renderBar();
  }

  // ---------- search box ----------

  private buildSearch(header: HTMLElement): void {
    const box = header.createDiv({ cls: "trova-seek-search" });
    setIcon(box.createSpan({ cls: "trova-seek-icon", attr: { "aria-hidden": "true" } }), "search");
    const input = (this.inputEl = box.createEl("textarea", { cls: "trova-seek-input", attr: { rows: "1", placeholder: t("seekPlaceholder"), spellcheck: "false" } }));
    quietLabel(input, t("askPlaceholder"));
    const grow = () => {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
    };
    input.addEventListener("input", () => {
      grow();
      if (input.value.trim() === "") {
        if (this.ask.active) this.backToRelated(false);
        else this.ask.cancelPreview();
      } else this.ask.preview(input.value);
      this.renderClear();
    });
    input.addEventListener("keydown", (e) => {
      // Enter that confirms an IME composition is not a search, and neither is Enter with Mod or
      // Alt. An empty box runs nothing, and leaves alone a search the user did not type, such as
      // "About this note".
      if (e.key === "Enter" && !e.shiftKey && !e.altKey && !Keymap.isModifier(e, "Mod") && !e.isComposing) {
        e.preventDefault();
        if (input.value.trim()) void this.ask.run(input.value);
      } else if (e.key === "Escape") {
        if (input.value || this.ask.active) {
          e.preventDefault();
          e.stopPropagation();
          this.backToRelated(true);
        }
      } else if (e.key === "ArrowDown" && !e.shiftKey && input.selectionStart === input.value.length) {
        e.preventDefault();
        moveFocus(this.bodyEl, null, 1);
      }
    });
    input.addEventListener("focus", () => this.contentEl.addClass("is-searching"));
    input.addEventListener("blur", () => this.contentEl.removeClass("is-searching"));

    this.modeEl = box.createEl("button", { cls: "trova-seek-mode", attr: { "aria-haspopup": "menu" } });
    this.modeEl.addEventListener("click", (e) => this.modeMenu(e));
    this.renderMode();
    this.clearEl = box.createEl("button", { cls: "clickable-icon trova-seek-clear", attr: { "aria-label": t("clearQuestion") } });
    setIcon(this.clearEl, "x");
    this.clearEl.addEventListener("click", () => this.backToRelated(true));
    const more = box.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("paneMenu"), "aria-haspopup": "menu" } });
    setIcon(more, "more-horizontal");
    more.addEventListener("click", (e) => this.paneMenu(e));
    this.renderClear();
  }

  private renderMode(): void {
    const name = this.ask.mode === "deep" ? t("modeDeep") : this.ask.mode === "fast" ? t("modeFast") : t("modeAuto");
    this.modeEl.setText(name);
    this.modeEl.setAttribute("aria-label", `${t("askModeLabel")}: ${name}`);
  }

  private renderClear(): void {
    this.clearEl.toggleClass("is-hidden", !this.inputEl.value && !this.ask.active);
  }

  private modeMenu(e: MouseEvent): void {
    showMenu(e, (menu) => {
      for (const [mode, label] of [["auto", t("modeAuto")], ["fast", t("modeFast")], ["deep", t("modeDeep")]] as [AskMode, string][]) {
        menu.addItem((i) =>
          i.setTitle(label).setChecked(this.ask.mode === mode).onClick(() => {
            this.ask.mode = mode;
            this.renderMode();
            if (this.ask.question) void this.ask.run(this.ask.question, { record: false, label: this.ask.label });
          }),
        );
      }
    });
  }

  /** Clears the question and shows related notes again. */
  private backToRelated(focus: boolean): void {
    this.ask.clear();
    this.inputEl.value = "";
    this.inputEl.style.height = "";
    this.renderClear();
    this.render();
    if (focus) this.inputEl.focus();
  }

  focusInput(): void {
    this.inputEl.focus();
    this.inputEl.select();
  }

  /** Runs a question in the pane. `label` names a question the user did not type. */
  runQuestion(question: string, opts: { mode?: AskMode; label?: string } = {}): void {
    this.inputEl.value = opts.label ? "" : question;
    this.renderClear();
    void this.ask.run(question, opts);
  }

  /** "More like this" from any result. */
  moreLike(r: Result): void {
    this.inputEl.value = "";
    void this.ask.moreLike(r);
    this.renderClear();
  }

  // ---------- anchors ----------

  private activeMarkdown(): MarkdownView | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view) return view;
    // The pane itself may be the active leaf; fall back to the most recent markdown leaf.
    const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
    return leaf?.view instanceof MarkdownView ? leaf.view : null;
  }

  /** True when a tab in the editor area shows the note at `path`. */
  private isOpen(path: string): boolean {
    const root = this.app.workspace.rootSplit;
    return this.app.workspace.getLeavesOfType("markdown").some((l) => l.getRoot() === root && (l.view as MarkdownView).file?.path === path);
  }

  private computeAnchor(): Anchor | null {
    const md = this.activeMarkdown();
    const file = md?.file;
    if (!md || !file || file.extension !== "md") return null;
    if (this.kind === "block") {
      const cache = this.app.metadataCache.getFileCache(file);
      const line = md.editor?.getCursor().line ?? 0;
      const section = sectionAt((cache?.headings ?? []).map((h) => ({ heading: h.heading, level: h.level, line: h.position.start.line })), line);
      return { kind: "block", path: file.path, ...section };
    }
    return { kind: "note", path: file.path };
  }

  private sameAnchor(a: Anchor | null, b: Anchor | null): boolean {
    if (!a || !b) return a === b;
    if (a.kind !== b.kind || a.path !== b.path) return false;
    if (a.kind === "block" && b.kind === "block") return a.headingPath === b.headingPath;
    return a.kind !== "selection";
  }

  /** Follows the active note or the section under the cursor, unless locked or on a selection. */
  followActive(): void {
    if (this.locked || this.kind === "selection") return;
    const next = this.computeAnchor();
    // A tab with no note, such as the similarity graph, is not a new note: while the current note
    // is still open somewhere in the editor area, the pane keeps it.
    if (!next && this.anchor && this.isOpen(this.anchor.path)) return;
    if (this.sameAnchor(next, this.anchor) && this.view) return;
    this.anchor = next;
    void this.refresh(false);
  }

  setKind(kind: AnchorKind): void {
    if (kind === "selection") {
      // The editor keeps its selection while the pane has focus, so the switch can read it.
      const md = this.activeMarkdown();
      const text = md?.editor.getSelection().trim();
      const last = this.lastSelection;
      if ((!md?.file || !text) && last && this.app.vault.getAbstractFileByPath(last.path) instanceof TFile) {
        this.locked = false;
        this.showSelection(last.path, last.text);
        return;
      }
      if (!md?.file || !text) {
        // Selection mode starts empty; the pane asks for a selection and fills in when there is one.
        this.kind = "selection";
        this.locked = false;
        this.abort?.abort();
        this.anchor = null;
        this.view = null;
        this.loading = false;
        this.render();
        return;
      }
      this.locked = false;
      this.showSelection(md.file.path, text);
      return;
    }
    this.kind = kind;
    this.locked = false;
    this.anchor = this.computeAnchor();
    void this.refresh(false);
  }

  /**
   * In Selection mode the anchor follows a new selection in the editor. An empty selection, such as
   * a click in the editor or in this pane, keeps the current anchor.
   */
  private followSelection(force = false): void {
    if (this.locked || this.kind !== "selection") return;
    const md = this.activeMarkdown();
    const text = md?.editor.getSelection().trim();
    if (!md?.file || !text) {
      if (force) void this.refresh(false);
      return;
    }
    if (!force && this.anchor?.kind === "selection" && this.anchor.path === md.file.path && this.anchor.text === text) return;
    this.showSelection(md.file.path, text);
  }

  /** Whether the selection came from another note than the open one, which the context line then names. */
  private showsSource(): boolean {
    return !this.ask.active && this.anchor?.kind === "selection" && this.anchor.path !== this.app.workspace.getActiveFile()?.path;
  }

  /**
   * Adds or removes the selection's note link after a note switch. The bar is redrawn only when
   * the link changes, so focus on a scope button survives a click into the pane.
   */
  private syncSourceLink(): void {
    if (this.showsSource() !== this.sourceShown) this.renderBar();
  }

  /** Opens the note a selection came from, with the selected text flashed when it is still there. */
  private async openSelectionSource(path: string, text: string, where: OpenIn): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const at = (await this.app.vault.cachedRead(file)).indexOf(text);
    await this.plugin.open(at === -1 ? { path } : { path, offset: at, length: text.length }, where);
  }

  /** The "Connections for selection" command. */
  showSelection(path: string, text: string): void {
    this.kind = "selection";
    this.anchor = { kind: "selection", path, text };
    this.lastSelection = { path, text };
    this.selectionGone = false;
    void this.refresh(false);
    void this.checkSelectionText();
  }

  /** Marks the selection when its note no longer contains the selected text. It is not cleared: the user may be editing it. */
  private async checkSelectionText(): Promise<void> {
    const anchor = this.anchor;
    if (anchor?.kind !== "selection") return;
    const file = this.app.vault.getAbstractFileByPath(anchor.path);
    const gone = !(file instanceof TFile) || !(await this.app.vault.cachedRead(file)).includes(anchor.text);
    if (this.anchor !== anchor || gone === this.selectionGone) return;
    this.selectionGone = gone;
    this.renderBar();
  }

  /**
   * The context line's × in Selection mode: forgets the selection and waits for a new one. It also
   * unlocks the pane, as every scope change does, since a locked pane would ignore the next selection.
   */
  private clearSelection(): void {
    this.locked = false;
    this.lastSelection = null;
    this.selectionGone = false;
    this.anchor = null;
    void this.refresh(false);
    this.barEl.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
  }

  private applyCached(): void {
    if (!this.anchor || !this.view || this.view.state !== "ok") return;
    const cached = this.plugin.connections.cached(this.anchor);
    if (cached) {
      this.view = cached;
      this.render();
    }
  }

  async refresh(background: boolean): Promise<void> {
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    const anchor = this.anchor;
    this.loadNoteExtras(anchor?.path ?? null);
    if (this.drawerOpen) void this.graph?.load(anchor?.path ?? null, false);
    if (!anchor) {
      this.view = null;
      this.render();
      return;
    }
    // Cached results show at once; the refresh runs behind them.
    const cached = this.plugin.connections.cached(anchor);
    if (cached) this.view = cached;
    else if (!background) this.view = null;
    this.loading = true;
    this.render();
    try {
      const view = await this.plugin.connections.related(anchor, abort.signal);
      if (abort.signal.aborted) return;
      this.view = view;
    } catch {
      if (abort.signal.aborted) return;
      this.view = { state: "offline", anchor, results: cached?.results ?? [], stale: false, pinned: cached?.pinned ?? new Set() };
    }
    this.loading = false;
    this.render();
  }

  /**
   * Loads what the pane shows about the note itself, apart from its related notes: unlinked
   * mentions from the plugin's own index, and a near-duplicate from the engine's last scan. Both
   * are cheap reads; neither starts a scan.
   */
  private loadNoteExtras(path: string | null): void {
    if (path === this.mentions?.path) return;
    this.mentionsAbort?.abort();
    this.mentions = null;
    const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const abort = (this.mentionsAbort = new AbortController());
    void findMentions(this.plugin, file, abort.signal).then((hits) => {
      if (abort.signal.aborted) return;
      this.mentions = { path: file.path, hits };
      if (!this.ask.active) this.render();
    });
    void this.loadDuplicates();
  }

  private async loadDuplicates(): Promise<void> {
    if (!this.plugin.engine.ready) return;
    if (this.duplicates && Date.now() - this.duplicates.at < DUPLICATES_TTL_MS) return;
    try {
      const data = await this.plugin.engine.duplicates(false);
      this.duplicates = { at: Date.now(), data };
      if (!this.ask.active) this.render();
    } catch {
      /* no scan, or no engine: the pane shows no warning */
    }
  }

  private reloadMentions(): void {
    const path = this.mentions?.path ?? this.anchor?.path ?? null;
    this.mentions = null;
    this.loadNoteExtras(path);
  }

  // ---------- rendering ----------

  private render(): void {
    this.renderBar();
    this.renderStatus();
    this.renderBody();
    this.contentEl.toggleClass("is-asking", this.ask.active);
  }

  /** The scope switch and the context line under the search box. */
  private renderBar(): void {
    const el = this.barEl;
    el.empty();
    this.renderClear();
    if (this.ask.active) {
      // One line for the answers: what they are, which mode they came from, and, after a typing
      // preview, the key that runs a Deep search. The hint is clickable for mouse and touch.
      const line = el.createDiv({ cls: "trova-seek-context" });
      // Ask always asks for the same number of answers, so the count says something only when
      // fewer came back.
      const fewer = this.ask.final && this.ask.count < ASK_ANSWERS;
      const what = this.ask.label || (fewer ? t("answersCount", { n: this.ask.count }) : t("answers"));
      const mode = this.ask.modeText();
      const text = line.createSpan({ cls: "trova-seek-context-text", text: what });
      if (mode) text.createSpan({ cls: "trova-seek-mode-text", text: ` · ${mode}` });
      if (this.ask.offersDeep()) {
        const hint = line.createEl("button", { cls: "trova-key-hint", attr: { "aria-keyshortcuts": "Enter" } });
        quietLabel(hint, t("runDeepLabel"));
        hint.createEl("kbd", { text: "↵", attr: { "aria-hidden": "true" } });
        hint.createSpan({ text: t("modeDeep"), attr: { "aria-hidden": "true" } });
        hint.addEventListener("click", () => this.ask.runAgain());
      }
      const back = line.createEl("button", { cls: "trova-link-button", attr: { "aria-keyshortcuts": "Escape" } });
      setIcon(back.createSpan({ attr: { "aria-hidden": "true" } }), "arrow-left");
      back.appendText(t("backToRelated"));
      back.addEventListener("click", () => this.backToRelated(true));
      return;
    }

    const row = el.createDiv({ cls: "trova-seek-scope" });
    const seg = row.createDiv({ cls: "trova-segmented", attr: { role: "radiogroup" } });
    quietLabel(seg, t("scopeLabel"));
    const kinds: [AnchorKind, string][] = [["note", t("anchorNote")], ["block", t("anchorBlock")], ["selection", t("anchorSelection")]];
    for (const [kind, label] of kinds) {
      const on = kind === this.kind;
      const b = seg.createEl("button", { text: label, cls: on ? "is-active" : "", attr: { role: "radio", "aria-checked": String(on), tabindex: on ? "0" : "-1" } });
      b.addEventListener("click", () => this.setKind(kind));
    }
    // A radio group moves with the arrow keys, and Tab stops on the checked option only.
    seg.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      e.preventDefault();
      const at = kinds.findIndex(([k]) => k === this.kind);
      const next = (at + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1) + kinds.length) % kinds.length;
      this.setKind(kinds[next]![0]);
      this.barEl.querySelectorAll<HTMLElement>(".trova-segmented [role=radio]")[next]?.focus();
    });
    const lock = row.createEl("button", { cls: `clickable-icon${this.locked ? " is-active" : ""}`, attr: { "aria-label": this.locked ? t("unlockAnchor") : t("lockAnchor"), "aria-pressed": String(this.locked) } });
    setIcon(lock, this.locked ? "lock" : "unlock");
    lock.addEventListener("click", () => {
      this.locked = !this.locked;
      if (!this.locked) this.followActive();
      this.renderBar();
    });

    const line = el.createDiv({ cls: "trova-seek-context" });
    this.sourceShown = false;
    if (this.anchor) {
      const name = this.anchor.path.split("/").pop()!.replace(/\.md$/, "");
      const detail = this.anchor.kind === "block" ? (this.anchor.headings.join(" › ") || name) : this.anchor.kind === "selection" ? `“${this.anchor.text.slice(0, 60)}${this.anchor.text.length > 60 ? "…" : ""}”` : name;
      setIcon(line.createSpan({ cls: "trova-seek-context-icon", attr: { "aria-hidden": "true" } }), this.anchor.kind === "note" ? "file-text" : this.anchor.kind === "block" ? "heading" : "text-cursor");
      const text = line.createSpan({ cls: "trova-seek-context-text" });
      text.appendText(`${t("relatedTo")} `);
      text.createSpan({ cls: "trova-anchor-name", text: detail });
      // A selection from another note than the open one names its note, which opens at the text.
      const anchor = this.anchor;
      if (anchor.kind === "selection" && this.showsSource()) {
        this.sourceShown = true;
        text.appendText(` ${t("selectionIn")} `);
        const source = text.createEl("button", { cls: "trova-anchor-source", text: name });
        onOpen(source, (where) => void this.openSelectionSource(anchor.path, anchor.text, where));
      }
    }
    if (this.locked) line.createSpan({ cls: "trova-badge", text: t("locked") });
    if (this.view?.stale) line.createSpan({ cls: "trova-badge trova-badge-stale", text: "●", attr: { role: "img", "aria-label": t("stale") } });
    if (this.anchor?.kind === "selection" && !this.ask.active) {
      if (this.selectionGone) line.createSpan({ cls: "trova-badge trova-badge-stale", text: "●", attr: { role: "img", "aria-label": t("selectionGone") } });
      const clear = line.createEl("button", { cls: "clickable-icon trova-selection-clear", attr: { "aria-label": t("clearSelection") } });
      setIcon(clear, "x");
      clear.addEventListener("click", () => this.clearSelection());
    }
    const re = this.plugin.engine.snapshot.status?.reembedding;
    if (re && re.total > 0) line.createSpan({ cls: "trova-badge", text: t("reembedding", { pct: Math.round((re.done / re.total) * 100) }) });

    const filters = this.plugin.store.data.filters.connections;
    if (filters.length || this.plugin.settings.hideLinked) {
      const chips = el.createDiv({ cls: "trova-chips" });
      const chip = (text: string, remove: () => void) => {
        const b = chips.createEl("button", { cls: "trova-chip trova-chip-remove", attr: { "aria-label": `${t("removeFilter")}: ${text}` } });
        b.appendText(text);
        setIcon(b.createSpan({ cls: "trova-chip-x", attr: { "aria-hidden": "true" } }), "x");
        b.addEventListener("click", remove);
      };
      if (this.plugin.settings.hideLinked) chip(t("filterHideLinked"), () => this.toggleSetting("hideLinked"));
      for (const f of filters) chip(`${f.negate ? "-" : ""}${f.field}:${String(f.value)}`, () => this.setFilters(filters.filter((x) => x !== f)));
    }
  }

  private renderStatus(): void {
    this.statusEl.empty();
    if (this.ask.active) this.ask.renderStatus(this.statusEl);
  }

  private renderBody(): void {
    const el = this.bodyEl;
    // Keep keyboard focus on the same row across a re-render.
    const focused = el.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset["key"] : undefined;
    el.empty();
    if (this.ask.active) this.ask.renderList(el);
    else this.renderRelated(el);
    if (focused) el.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus();
  }

  private renderRelated(el: HTMLElement): void {
    const view = this.view;
    const message = (text: string) => el.createDiv({ cls: "trova-empty", text });
    if (!this.anchor) return void message(this.kind === "selection" ? t("selectionWaiting") : t("noActiveNote"));
    this.renderDuplicate(el);
    if (!view) {
      if (this.loading) skeletonAfter(el, () => this.loading && !this.view);
      return this.renderMentions(el);
    }
    if (view.state === "offline") {
      if (this.plugin.engine.snapshot.state === "disabled") message(t("needsEngine"));
      else banner(el, t("engineOffBanner"), { label: t("startEngine"), run: () => void this.plugin.engine.connect(true) });
      if (view.results.length === 0) return this.renderMentions(el);
    }
    if (view.state === "tooShort") message(t("tooShort"));
    else if (view.state === "notIndexed") message(t("notIndexedYet"));
    else if (view.state === "noNote") message(t("noActiveNote"));
    else if (view.state === "excluded") {
      const box = message(t("noteExcluded"));
      box.createEl("br");
      box.createEl("a", { text: t("openSetting"), href: "#" }).addEventListener("click", (e) => {
        e.preventDefault();
        this.plugin.openSettings();
      });
    } else {
      if (view.stale) el.createDiv({ cls: "trova-stale-note", text: t("stale") });
      if (view.results.length === 0) message(t("noConnections"));
      else {
        el.createDiv({ cls: "trova-group-head", text: t("similarNotes") }).createSpan({ cls: "trova-group-count", text: String(view.results.length) });
        const list = el.createDiv({ cls: "trova-results", attr: { role: "list" } });
        quietLabel(list, t("similarNotes"));
        for (const r of view.results) this.renderResult(list, r, view.pinned.has(r.id));
      }
    }
    this.renderMentions(el);
  }

  /**
   * The near-duplicate alert, from the engine's last duplicate scan. Each scope shows only pairs of its own kind: whole notes in Note, this
   * section in Section, and none in Selection, because the scan never compares a selection.
   */
  private renderDuplicate(el: HTMLElement): void {
    const anchor = this.anchor;
    const pairs = this.duplicates?.data.pairs;
    if (!anchor || anchor.kind === "selection" || !pairs) return;
    const store = this.plugin.store;
    const dup = duplicateOf(pairs.filter((p) => !store.isNotDuplicate(p.a, p.b)), anchor.path, anchor.kind === "block" ? anchor.headingPath : undefined);
    if (!dup) return;
    const pct = Math.round(dup.pair.similarity * 100);
    const text = anchor.kind === "block" ? t("dupThisSection", { pct, title: dup.otherTitle }) : t("dupWarning", { pct, title: dup.otherTitle });
    const path = anchor.path;
    const box = el.createDiv({ cls: "trova-alert", attr: { role: "note" } });
    setIcon(box.createSpan({ cls: "trova-alert-icon", attr: { "aria-hidden": "true" } }), "copy");
    box.createSpan({ cls: "trova-alert-text", text });
    box.createEl("button", { text: t("compare") }).addEventListener("click", () => void this.plugin.openBeside(dup.otherId, { besidePath: path, reuse: true, own: dup.ownId }));
  }

  private renderResult(list: HTMLElement, r: Result, pinned: boolean): void {
    const group = list.createDiv({ cls: "trova-conn", attr: { role: "listitem" } });
    const head = group.createDiv({ cls: "trova-conn-head", attr: { draggable: "true", tabindex: "0", "data-row": "", "data-key": r.id, "data-path": r.path } });
    if (r.path === this.selectedPath) head.addClass("is-selected");
    const blocks = r.blocks ?? [];
    const reason = reasonParts(r);
    // A row expands when it has something to show: why it is related, or its matching sections.
    const expandable = blocks.length > 0 || reason !== null;
    const open = expandable && (this.allExpanded || this.expanded.has(r.id));
    const setOpen = (next: boolean) => {
      if (!expandable || next === open) return;
      if (next) this.expanded.add(r.id);
      else this.expanded.delete(r.id);
      this.allExpanded = false;
      this.render();
    };
    const toggle = head.createEl("button", { cls: "trova-conn-toggle", attr: { "aria-label": open ? t("hideDetails") : t("showDetails"), "aria-expanded": String(open), tabindex: "-1" } });
    setIcon(toggle, open ? "chevron-down" : "chevron-right");
    if (!expandable) toggle.addClass("is-hidden");
    else head.setAttribute("aria-expanded", String(open));
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      setOpen(!open);
    });
    if (pinned) setIcon(head.createSpan({ cls: "trova-pin", attr: { "aria-label": t("pinned") } }), "pin");
    head.createSpan({ cls: "trova-conn-title", text: r.title });
    const folder = folderOf(r.path);
    if (folder) head.createSpan({ cls: "trova-row-path", text: folder });
    if (r.type) head.createSpan({ cls: "trova-badge trova-badge-type", text: r.type });
    const actions = head.createSpan({ cls: "trova-row-actions" });
    this.rowAction(actions, "link", t("insertLink"), () => this.plugin.insertLink(r));
    this.rowAction(actions, "file-plus", t("openNewTab"), () => void this.plugin.openResult(r, "tab"));
    if (r.matchedBy.length) renderMeter(head, r.label, r.scores.vec);
    this.wireResult(head, r, r, { expand: setOpen, toggle: () => setOpen(!open) });
    if (!open) return;
    if (reason) {
      // One quiet line: the score first, then what the two notes share.
      const line = group.createDiv({ cls: "trova-whyline" });
      if (reason.score) line.createSpan({ cls: "trova-whyline-score", text: reason.score });
      for (const part of reason.rest) {
        if (line.childElementCount) line.createSpan({ cls: "trova-whyline-sep", text: " · ", attr: { "aria-hidden": "true" } });
        line.createSpan({ text: part });
      }
      line.setAttribute("title", reason.full);
    }
    for (const b of blocks) {
      const row = group.createDiv({ cls: "trova-conn-block", attr: { draggable: "true", tabindex: "0", "data-row": "", "data-key": b.id, "data-path": r.path } });
      const top = row.createDiv({ cls: "trova-row-head" });
      top.createSpan({ cls: "trova-row-heading", text: b.block?.headings.join(" › ") || r.title });
      const add = top.createEl("button", { cls: "clickable-icon trova-basket-btn", attr: { "aria-label": t("addToBasket") } });
      setIcon(add, "shopping-basket");
      add.addEventListener("click", (e) => {
        e.stopPropagation();
        this.plugin.addResultToBasket(b);
      });
      renderMeter(top, b.label, b.scores.vec);
      const heading = b.block?.headings.at(-1);
      renderHighlighted(row.createDiv({ cls: "trova-row-snippet" }), stripHeading(b.snippet, heading), shiftHighlights(b.snippet, b.highlights, heading));
      this.wireResult(row, b, r, { expand: (next) => !next && (head.focus(), setOpen(false)), toggle: () => (head.focus(), setOpen(false)) });
    }
  }

  private rowAction(parent: HTMLElement, icon: string, label: string, run: () => void): void {
    const b = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label, tabindex: "-1" } });
    setIcon(b, icon);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      run();
    });
  }

  /** Click, modifier clicks, hover preview, drag to link, keyboard and the result menu. */
  private wireResult(el: HTMLElement, r: Result, parent: Result, extra: Pick<RowWiring, "expand" | "toggle">): void {
    const heading = r.block?.headings[r.block.headings.length - 1];
    // Page preview decides whether the hover needs Mod, from the user's setting for this pane.
    el.addEventListener("mouseover", (e) => {
      if (r.collection !== this.plugin.collection) return;
      this.app.workspace.trigger("hover-link", { event: e, source: CONNECTIONS_VIEW, hoverParent: this, targetEl: el, linktext: heading ? `${r.path}#${heading}` : r.path, sourcePath: this.anchor?.path ?? "" });
    });
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("text/plain", linkFor(this.app, r.path, heading, this.anchor?.path ?? ""));
    });
    this.wireRow(el, {
      path: r.path,
      open: (where) => void this.plugin.openResult(r, where),
      insertLink: () => this.plugin.insertLink(r),
      menu: (e) => this.resultMenu(e, r, parent),
      ...extra,
    });
  }

  /**
   * The behaviour every row shares. Click or Enter opens; with Mod it opens in a new tab, with
   * Mod+Alt in a split and with Mod+Alt+Shift in a window; a middle-click opens in a new tab.
   * Alt+Enter inserts a link; Up and Down move between rows; Right and Left, or `i`, show or hide
   * a row's details; Shift+F10 or the menu key opens the row's menu; Esc goes to the search box.
   * Hover and focus light the row's node in the graph.
   */
  private wireRow(el: HTMLElement, w: RowWiring): void {
    el.addEventListener("click", (e) => {
      this.setSelected(w.path, false);
      w.open(openIn(e));
    });
    el.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault());
    el.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      this.setSelected(w.path, false);
      w.open("tab");
    });
    el.addEventListener("keydown", (e) => {
      if (e.target !== el) return;
      if (isLinkKey(e)) {
        e.preventDefault();
        w.insertLink();
      } else if (e.key === "Enter") {
        e.preventDefault();
        this.setSelected(w.path, false);
        w.open(openIn(e));
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = moveFocus(this.bodyEl, el, e.key === "ArrowDown" ? 1 : -1);
        if (next === el && e.key === "ArrowUp") this.inputEl.focus();
      } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && w.expand) {
        e.preventDefault();
        w.expand(e.key === "ArrowRight");
      } else if (e.key === "i" && w.toggle) {
        e.preventDefault();
        w.toggle();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.inputEl.focus();
      } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        w.menu(new MouseEvent("contextmenu", { clientX: rect.left + 24, clientY: rect.bottom }));
      }
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      w.menu(e);
    });
    const light = () => this.graph?.highlightPath(w.path);
    const unlight = () => this.graph?.highlightPath(null);
    el.addEventListener("mouseenter", light);
    el.addEventListener("focus", light);
    el.addEventListener("mouseleave", unlight);
    el.addEventListener("blur", unlight);
  }

  /** Marks the row of a note as selected, in the list and in the graph. */
  private setSelected(path: string | null, fromGraph: boolean): void {
    this.selectedPath = path;
    for (const row of this.bodyEl.querySelectorAll<HTMLElement>("[data-path]")) row.toggleClass("is-selected", !!path && row.dataset["path"] === path);
    if (fromGraph && path) this.bodyEl.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "nearest" });
    if (!fromGraph) this.graph?.selectPath(path);
  }

  // ---------- unlinked mentions ----------

  private renderMentions(el: HTMLElement): void {
    const m = this.mentions;
    if (!m || m.path !== this.anchor?.path || m.hits.length === 0) return;
    const file = this.app.vault.getAbstractFileByPath(m.path);
    if (!(file instanceof TFile)) return;
    const collapsed = storedBoolean(this.plugin.local.get("mentions-collapsed")) === true;
    const total = mentionCount(m.hits);
    const head = el.createDiv({ cls: "trova-group-head" });
    const toggle = head.createEl("button", { cls: "trova-group-toggle", attr: { "aria-expanded": String(!collapsed) } });
    setIcon(toggle.createSpan({ attr: { "aria-hidden": "true" } }), collapsed ? "chevron-right" : "chevron-down");
    toggle.appendText(t("mentionsGroup"));
    toggle.createSpan({ cls: "trova-group-count", text: String(total) });
    toggle.addEventListener("click", () => {
      this.plugin.local.set("mentions-collapsed", !collapsed);
      this.render();
    });
    if (total > 1 && !collapsed) {
      head.createEl("button", { cls: "trova-link-button", text: t("linkAll") }).addEventListener("click", () => confirmLinkAll(this.plugin, file, m.hits, () => this.reloadMentions()));
    }
    if (collapsed) return;
    const list = el.createDiv({ cls: "trova-results", attr: { role: "list" } });
    quietLabel(list, t("mentionsGroup"));
    for (const hit of m.hits) {
      const group = list.createDiv({ cls: "trova-conn", attr: { role: "listitem" } });
      const title = group.createDiv({ cls: "trova-conn-head", attr: { tabindex: "0", "data-row": "", "data-key": `mention:${hit.path}`, "data-path": hit.path } });
      title.createSpan({ cls: "trova-conn-title", text: hit.title });
      title.createSpan({ cls: "trova-row-path", text: folderOf(hit.path) });
      const first = hit.mentions[0]!;
      this.wireRow(title, {
        path: hit.path,
        open: (where) => void this.plugin.open({ path: hit.path, offset: first.start, length: first.name.length }, where),
        insertLink: () => {
          const md = this.activeMarkdown();
          md?.editor.replaceSelection(linkFor(this.app, hit.path, undefined, md.file?.path ?? ""));
        },
        menu: (e) =>
          showMenu(e, (menu) => {
            menu.addItem((i) => i.setTitle(t("open")).setIcon("file").onClick(() => void this.plugin.open({ path: hit.path, offset: first.start, length: first.name.length }, false)));
            menu.addItem((i) => i.setTitle(t("openNewTab")).setIcon("file-plus").onClick(() => void this.plugin.open({ path: hit.path, offset: first.start, length: first.name.length }, "tab")));
            menu.addItem((i) => i.setTitle(t("linkIt")).setIcon("link").onClick(() => void linkMentions(this.plugin, file, [hit], () => this.reloadMentions()).then(() => this.reloadMentions())));
          }),
      });
      for (const mention of hit.mentions) {
        const row = group.createDiv({ cls: "trova-care-row" });
        const text = row.createDiv({ cls: "trova-row-snippet" });
        const at = mention.start - mention.contextStart;
        text.appendText(mention.context.slice(0, at));
        text.createEl("mark", { text: mention.name, cls: "trova-hl" });
        text.appendText(mention.context.slice(at + mention.name.length));
        row.createEl("button", { text: t("linkIt"), cls: "trova-small-button" }).addEventListener("click", () =>
          void linkMentions(this.plugin, file, [{ ...hit, mentions: [mention] }], () => this.reloadMentions()).then(() => this.reloadMentions()),
        );
      }
    }
  }

  // ---------- menus ----------

  private resultMenu(e: MouseEvent, r: Result, parent: Result): void {
    const anchor = this.anchor;
    if (!anchor) return;
    const anchorId = this.plugin.sourceId(anchor.path);
    const store = this.plugin.store;
    const pinned = store.pins(anchorId).includes(parent.id);
    showMenu(e, (menu) => {
      menu.addItem((i) => i.setTitle(t("open")).setIcon("file").onClick(() => void this.plugin.openResult(r, false)));
      menu.addItem((i) => i.setTitle(t("openNewTab")).setIcon("file-plus").onClick(() => void this.plugin.openResult(r, "tab")));
      menu.addItem((i) => i.setTitle(t("insertLink")).setIcon("link").onClick(() => this.plugin.insertLink(r)));
      menu.addSeparator();
      menu.addItem((i) => i.setTitle(t("addToBasket")).setIcon("shopping-basket").onClick(() => this.plugin.addResultToBasket(r)));
      if (r.block) menu.addItem((i) => i.setTitle(t("addBlockNeighbours")).setIcon("list-plus").onClick(() => this.plugin.addResultToBasket(r, true)));
      menu.addItem((i) => i.setTitle(t("moreLikeThis")).setIcon("sparkles").onClick(() => this.moreLike(r)));
      if (r.collection === this.plugin.collection) {
        menu.addItem((i) => i.setTitle(t("graphCenter")).setIcon("locate-fixed").onClick(() => this.centreGraph(r.path)));
        menu.addItem((i) => i.setTitle(t("graphOpenHere")).setIcon("git-fork").onClick(() => void this.plugin.openGraph(r.path)));
      }
      menu.addSeparator();
      menu.addItem((i) =>
        i.setTitle(pinned ? t("unpin") : t("pin")).setIcon("pin").onClick(() => {
          store.setPinned(anchorId, parent.id, !pinned);
          if (pinned) undoNotice(t("unpinned"), () => store.setPinned(anchorId, parent.id, true));
        }),
      );
      menu.addItem((i) =>
        i.setTitle(t("hide")).setIcon("eye-off").onClick(() => {
          store.setHidden(anchorId, parent.id, true);
          undoNotice(t("hidden"), () => store.setHidden(anchorId, parent.id, false));
        }),
      );
    });
  }

  private setFilters(next: Filter[]): void {
    this.plugin.store.setConnectionFilters(next);
    this.plugin.connections.clear();
    void this.refresh(false);
  }

  private toggleSetting(key: "hideLinked" | "showLoose"): void {
    this.plugin.store.updateSettings({ [key]: !this.plugin.settings[key] });
    this.plugin.connections.clear();
    void this.refresh(false);
  }

  private paneMenu(e: MouseEvent): void {
    const { store, settings } = this.plugin;
    const filters = store.data.filters.connections;
    const daily = this.plugin.dailyFolder();
    const hasDaily = daily !== null && filters.some((f) => f.field === "path" && f.negate && f.value === daily);
    showMenu(e, (menu) => {
      if (this.ask.active) {
        menu.addItem((i) => i.setTitle(t("explainToggle")).setIcon("bug").setChecked(this.ask.explain).onClick(() => {
          this.ask.explain = !this.ask.explain;
          this.render();
        }));
        menu.addItem((i) => i.setTitle(t("saveAsSearch")).setIcon("save").setDisabled(!this.ask.question).onClick(() => this.ask.saveAsSearch()));
      }
      menu.addItem((i) => i.setTitle(t("history")).setIcon("history").onClick(() =>
        this.ask.historyMenu(e, (query, mode) => this.runQuestion(query, { mode, label: query.startsWith("vec:") ? t("askHistoryPassage") : undefined })),
      ));
      menu.addSeparator();
      menu.addItem((i) => i.setTitle(t("refresh")).setIcon("refresh-cw").onClick(() => {
        if (this.ask.active && this.ask.question) return void this.ask.run(this.ask.question, { record: false, label: this.ask.label });
        if (!this.locked && this.kind === "selection") this.followSelection(true);
        else {
          if (!this.locked) this.anchor = this.computeAnchor();
          this.graph?.clearCache();
          void this.refresh(false);
        }
      }));
      if (!this.ask.active) {
        menu.addItem((i) => i.setTitle(this.allExpanded ? t("collapseAll") : t("expandAll")).setIcon("chevrons-up-down").onClick(() => {
          this.allExpanded = !this.allExpanded;
          this.expanded.clear();
          this.render();
        }));
        menu.addItem((i) => i.setTitle(t("copyAsLinks")).setIcon("copy").onClick(() => {
          const links = (this.view?.results ?? []).map((r) => `- ${linkFor(this.app, r.path, undefined, this.anchor?.path ?? "")}`);
          void navigator.clipboard.writeText(links.join("\n"));
          new Notice(t("copied"));
        }));
        menu.addItem((i) => i.setTitle(this.anchor?.kind === "block" ? t("askAboutSection") : t("askAboutNote")).setIcon("message-circle-question").onClick(() => void this.plugin.askAboutAnchor(this.anchor)));
        menu.addItem((i) => i.setTitle(t("graphOpenHere")).setIcon("git-fork").onClick(() => void this.plugin.openGraph(this.anchor?.path)));
        menu.addSeparator();
        menu.addItem((i) => i.setTitle(t("filterHideLinked")).setChecked(settings.hideLinked).onClick(() => this.toggleSetting("hideLinked")));
        menu.addItem((i) => i.setTitle(t("showLoose")).setChecked(settings.showLoose).onClick(() => this.toggleSetting("showLoose")));
        if (daily !== null) {
          menu.addItem((i) => i.setTitle(t("filterExcludeDaily")).setChecked(hasDaily).onClick(() =>
            this.setFilters(hasDaily ? filters.filter((f) => !(f.field === "path" && f.negate && f.value === daily)) : [...filters, { field: "path", op: "contains", value: daily, negate: true }]),
          ));
        }
        menu.addItem((i) => i.setTitle(t("filterFolder")).setIcon("folder").onClick(() =>
          this.plugin.prompt(t("filterFolder"), folderOf(this.anchor?.path ?? ""), (value) => {
            const rest = filters.filter((f) => !(f.field === "path" && !f.negate));
            this.setFilters(value.trim() ? [...rest, { field: "path", op: "contains", value: value.trim() }] : rest);
          }),
        ));
        menu.addItem((i) => i.setTitle(t("filterTag")).setIcon("tag").onClick(() =>
          this.plugin.prompt(t("filterTag"), "", (value) => {
            const rest = filters.filter((f) => f.field !== "tag");
            const tag = value.trim().replace(/^#/, "").toLowerCase();
            this.setFilters(tag ? [...rest, { field: "tag", op: "eq", value: tag }] : rest);
          }),
        ));
        if (filters.length) menu.addItem((i) => i.setTitle(t("filterClear")).setIcon("x").onClick(() => this.setFilters([])));
      }
      menu.addSeparator();
      menu.addItem((i) => i.setTitle(t("openVaultCare")).setIcon("heart-pulse").onClick(() => void this.plugin.openVaultCare()));
    });
  }

  // ---------- graph drawer ----------

  private buildDrawer(parent: HTMLElement): void {
    const drawer = (this.drawerEl = parent.createDiv({ cls: "trova-drawer" }));
    const handle = (this.handleEl = drawer.createDiv({
      cls: "trova-drawer-handle",
      attr: { role: "separator", tabindex: "0", "aria-orientation": "horizontal", "aria-valuemin": String(DRAWER_MIN) },
    }));
    quietLabel(handle, t("graphResize"));
    handle.addEventListener("pointerdown", (e) => this.startResize(e));
    handle.addEventListener("keydown", (e) => {
      const pane = this.contentEl.clientHeight;
      const step = e.shiftKey ? 64 : 24;
      if (e.key === "ArrowUp") this.setDrawerHeight(this.drawerHeight + step, true);
      else if (e.key === "ArrowDown") this.setDrawerHeight(this.drawerHeight - step, true);
      else if (e.key === "Home") this.setDrawerHeight(DRAWER_MIN, true);
      else if (e.key === "End") this.setDrawerHeight(pane, true);
      else if (e.key === "Enter" || e.key === " ") this.setDrawerOpen(false);
      else return;
      e.preventDefault();
    });
    this.drawerHeadEl = drawer.createDiv({ cls: "trova-drawer-head" });
    this.drawerBodyEl = drawer.createDiv({ cls: "trova-drawer-body" });
    this.renderDrawerHead();
  }

  private restoreDrawer(): void {
    const saved = storedBoolean(this.plugin.local.get("drawer-open"));
    const pane = this.contentEl.clientHeight;
    this.drawerHeight = storedNumber(this.plugin.local.get("drawer-height"), 0, 10_000, Math.round(pane * 0.4));
    this.setDrawerOpen(saved ?? pane >= DRAWER_AUTO_OPEN, false);
  }

  private setDrawerOpen(open: boolean, save = true): void {
    this.drawerOpen = open;
    if (save) this.plugin.local.set("drawer-open", open);
    this.drawerEl.toggleClass("is-open", open);
    if (open) {
      if (!this.graph) {
        this.graph = new SimilarityGraph(this.drawerBodyEl, this.plugin, {
          compact: true,
          limit: GRAPH_SIZES.find((n) => n === this.plugin.local.get("drawer-limit")) ?? DRAWER_LIMIT,
          loose: this.plugin.settings.showLoose,
          onSelect: (path) => this.setSelected(path, true),
          onChange: () => this.renderDrawerStatus(),
        });
      }
      this.setDrawerHeight(this.drawerHeight, false);
      void this.graph.load(this.anchor?.path ?? null, false);
    } else {
      this.drawerBodyEl.style.height = "";
    }
    this.renderDrawerHead();
  }

  private setDrawerHeight(height: number, save: boolean): void {
    const pane = this.contentEl.clientHeight || DRAWER_AUTO_OPEN;
    this.drawerHeight = clampDrawer(height, pane);
    if (this.drawerOpen) this.drawerBodyEl.style.height = `${this.drawerHeight}px`;
    this.handleEl.setAttribute("aria-valuenow", String(this.drawerHeight));
    this.handleEl.setAttribute("aria-valuemax", String(Math.max(DRAWER_MIN, pane - LIST_MIN)));
    if (save) this.plugin.local.set("drawer-height", this.drawerHeight);
  }

  private startResize(e: PointerEvent): void {
    if (e.button !== 0 || !this.drawerOpen) return;
    e.preventDefault();
    const handle = this.handleEl;
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startHeight = this.drawerHeight;
    this.contentEl.addClass("is-resizing");
    const move = (m: PointerEvent) => this.setDrawerHeight(startHeight - (m.clientY - startY), false);
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      this.contentEl.removeClass("is-resizing");
      this.plugin.local.set("drawer-height", this.drawerHeight);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  private renderDrawerHead(): void {
    const el = this.drawerHeadEl;
    el.empty();
    const row = el.createDiv({ cls: "trova-drawer-bar" });
    const toggle = row.createEl("button", { cls: "trova-group-toggle", attr: { "aria-expanded": String(this.drawerOpen) } });
    setIcon(toggle.createSpan({ attr: { "aria-hidden": "true" } }), this.drawerOpen ? "chevron-down" : "chevron-up");
    toggle.appendText(t("graph"));
    toggle.addEventListener("click", () => this.setDrawerOpen(!this.drawerOpen));
    row.createSpan({ cls: "trova-spinner" });
    row.createSpan({ cls: "trova-graph-count" });
    if (this.drawerOpen && this.graph) {
      const graph = this.graph;
      const select = row.createEl("select", { cls: "dropdown trova-drawer-size" });
      quietLabel(select, t("graphSize"));
      for (const n of GRAPH_SIZES) select.createEl("option", { text: t("graphNotes", { n }), value: String(n) });
      select.value = String(graph.limit);
      select.addEventListener("change", () => {
        graph.limit = Number(select.value);
        this.plugin.local.set("drawer-limit", graph.limit);
        void graph.load(graph.rootPath, true);
      });
      const button = (icon: string, label: string, run: () => void, pressed?: boolean) => {
        const b = row.createEl("button", { cls: `clickable-icon${pressed ? " is-active" : ""}`, attr: { "aria-label": label } });
        if (pressed !== undefined) b.setAttribute("aria-pressed", String(pressed));
        setIcon(b, icon);
        b.addEventListener("click", run);
      };
      button("circle-dashed", t("showLoose"), () => {
        graph.loose = !graph.loose;
        this.renderDrawerHead();
        void graph.load(graph.rootPath, true);
      }, graph.loose);
      button("maximize", t("graphFit"), () => graph.fit());
      button("maximize-2", t("graphOpenEditor"), () => void this.plugin.openGraph(graph.rootPath ?? this.anchor?.path));
    }
    this.renderDrawerStatus();
  }

  private renderDrawerStatus(): void {
    this.drawerHeadEl.querySelector(".trova-spinner")?.toggleClass("is-busy", !!this.graph?.busy);
    this.drawerHeadEl.querySelector(".trova-graph-count")?.setText(this.drawerOpen ? (this.graph?.countText() ?? "") : "");
  }

  /** Centres the drawer's graph on a note and opens the drawer if it is closed. */
  private centreGraph(path: string): void {
    if (!this.drawerOpen) this.setDrawerOpen(true);
    void this.graph?.load(path, true);
  }

  /**
   * Obsidian's status bar floats over the bottom right of the window. Core panes keep their own
   * bottom padding clear of it; this pane removes Obsidian's padding to lay out the drawer, so it
   * measures how much of it the status bar covers and leaves that much room.
   */
  private clearStatusBar(): void {
    const el = this.contentEl;
    const bar = document.body.querySelector<HTMLElement>(".status-bar");
    let overlap = 0;
    if (bar && bar.offsetParent !== null) {
      const pane = el.getBoundingClientRect();
      const status = bar.getBoundingClientRect();
      const sideBySide = status.right <= pane.left || status.left >= pane.right;
      if (!sideBySide && status.top < pane.bottom && status.bottom > pane.top) overlap = Math.ceil(pane.bottom - status.top);
    }
    const value = overlap > 0 ? `${overlap}px` : "";
    if (el.style.paddingBottom !== value) el.style.setProperty("padding-bottom", value, value ? "important" : "");
  }

}

export function resultHeading(r: Result): string | undefined {
  return r.block?.headings[r.block.headings.length - 1];
}

export function resultHeadingPath(r: Result): string | undefined {
  return r.block ? parseId(r.block.id)?.headingPath : undefined;
}
