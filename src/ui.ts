// Small DOM helpers shared by the views. Plain DOM with Obsidian's own components only.

import { Keymap, Menu, Modal, Notice, Platform, Scope, TFile, type App, type ItemView, type Modifier, type PaneType, type WorkspaceLeaf } from "obsidian";
import type { Label, MatchedBy } from "@trova/contract";
import { t, type StringKey } from "./i18n/en.js";

/** Renders text with <mark> around the highlighted character ranges. */
export function renderHighlighted(el: HTMLElement, text: string, ranges: [number, number][]): void {
  el.empty();
  let at = 0;
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (start < at || end > text.length || start >= end) continue;
    if (start > at) el.appendText(text.slice(at, start));
    el.createEl("mark", { text: text.slice(start, end), cls: "trova-hl" });
    at = end;
  }
  if (at < text.length) el.appendText(text.slice(at));
}

let labelSeq = 0;

/**
 * Gives an element an accessible name without a tooltip. Obsidian shows a tooltip for every
 * element with `aria-label`, which suits icon buttons but not lists, canvases or text fields.
 */
export function quietLabel(el: HTMLElement, text: string): void {
  const span = document.createElement("span");
  span.className = "trova-sr-only";
  span.textContent = text;
  span.id = `trova-label-${++labelSeq}`;
  el.insertAdjacentElement("beforebegin", span);
  el.removeAttribute("aria-label");
  el.setAttribute("aria-labelledby", span.id);
}

export function labelText(label: Label): string {
  return t(label);
}

export function badgeFor(by: MatchedBy): StringKey {
  return by === "lex" ? "badgeKeyword" : by === "fuzzy" ? "badgeFuzzy" : by === "vec" ? "badgeSemantic" : "badgeRerank";
}

export function renderBadges(el: HTMLElement, matchedBy: MatchedBy[], type?: string): void {
  if (type) el.createSpan({ cls: "trova-badge trova-badge-type", text: type });
  for (const by of matchedBy) el.createSpan({ cls: `trova-badge trova-badge-${by}`, text: t(badgeFor(by)) });
}

export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A notice with an Undo button, shown for 5 seconds. */
export function undoNotice(message: string, onUndo: () => void): void {
  const notice = new Notice("", 5000);
  const el = notice.messageEl ?? (notice as unknown as { noticeEl: HTMLElement }).noticeEl;
  el.empty();
  el.addClass("trova-undo");
  el.createSpan({ text: message });
  const button = el.createEl("button", { text: t("undo"), cls: "trova-undo-button" });
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    onUndo();
    notice.hide();
  });
}

/** Preview before bulk changes: lists the exact edits and needs a confirmation. */
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private body: string,
    private lines: string[],
    private confirmText: string,
    private onConfirm: () => void,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.createEl("p", { text: this.body });
    if (this.lines.length) {
      const list = this.contentEl.createEl("ul", { cls: "trova-confirm-list" });
      for (const line of this.lines.slice(0, 200)) list.createEl("li", { text: line });
      if (this.lines.length > 200) list.createEl("li", { text: `… +${this.lines.length - 200}` });
    }
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const ok = buttons.createEl("button", { text: this.confirmText, cls: "mod-cta" });
    ok.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
    buttons.createEl("button", { text: t("cancel") }).addEventListener("click", () => this.close());
    ok.focus();
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}

export interface OpenTarget {
  path: string;
  /** Absolute folder of an outside collection; undefined for vault files. */
  root?: string;
  headings?: string[];
  /** Character range of the match in the file, flashed after opening. */
  offset?: number;
  length?: number;
}

/** Where a note opens: `false` for the current tab, else a new tab, a split or a window. */
export type OpenIn = PaneType | boolean;

/**
 * Where a click or key press opens a note, by Obsidian's own rule: Mod (Cmd on macOS, Ctrl
 * elsewhere) for a new tab, Mod+Alt for a split to the right, Mod+Alt+Shift for a new window,
 * and a middle-click for a new tab.
 */
export function openIn(e: MouseEvent | KeyboardEvent): OpenIn {
  return Keymap.isModEvent(e);
}

/** Alt+Enter without Mod, which inserts a link where Mod+Alt+Enter opens a split. */
export function isLinkKey(e: KeyboardEvent): boolean {
  return e.key === "Enter" && e.altKey && !Keymap.isModifier(e, "Mod");
}

/**
 * Opens on click, middle-click and Enter, honouring the modifiers of `openIn`. Like Obsidian's own
 * links, the middle button's mousedown is cancelled, so it neither autoscrolls nor pastes. A button
 * gets no Enter handler of its own, because Enter on a button already clicks it.
 */
export function onOpen(el: HTMLElement, open: (where: OpenIn) => void): void {
  el.addEventListener("click", (e) => {
    e.preventDefault();
    open(openIn(e));
  });
  el.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault());
  el.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    open("tab");
  });
  if (el.tagName === "BUTTON") return;
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.target !== el) return;
    e.preventDefault();
    open(openIn(e));
  });
}

/**
 * Lets Mod+Enter, Mod+Alt+Enter, Mod+Alt+Shift+Enter and Alt+Enter reach a view's own key
 * handlers while the view is active. Obsidian binds them to its "open link under cursor" and
 * "follow link" editor commands and handles them before the page sees them. A handler in the
 * view's scope that returns true stops that and lets the key through to the focused element.
 */
export function passEnterKeys(view: ItemView): void {
  const scope = (view.scope ??= new Scope(view.app.scope));
  const mods: Modifier[][] = [["Mod"], ["Mod", "Alt"], ["Mod", "Alt", "Shift"], ["Alt"]];
  for (const m of mods) scope.register(m, "Enter", () => true);
}

/**
 * Keeps an editor-area view navigable, as Obsidian's own Graph view is: opening a note from it
 * replaces it in its tab, and Back returns to it. Moved into a sidebar, it stops being navigable
 * so notes open in the main area instead, as Obsidian does for Bases.
 */
export function navigableInMainArea(view: ItemView): void {
  const { workspace } = view.app;
  const update = () => {
    const root = view.leaf.getRoot();
    view.navigation = root !== workspace.leftSplit && root !== workspace.rightSplit;
  };
  update();
  view.registerEvent(workspace.on("layout-change", update));
}

/**
 * Opens a result: in the current tab, or where `where` says, or in `given`. Scrolls to the matched
 * block and highlights the match. Files outside the vault open in the default app.
 */
export async function openTarget(app: App, target: OpenTarget, where: OpenIn = false, given?: WorkspaceLeaf): Promise<void> {
  if (target.root) {
    if (Platform.isDesktopApp) {
      const electron = (globalThis as unknown as { require: (id: string) => { shell: { openPath(p: string): Promise<string> } } }).require("electron");
      await electron.shell.openPath(`${target.root.replace(/[\\/]+$/, "")}/${target.path}`);
      new Notice(t("attachmentOpened"));
    }
    return;
  }
  const file = app.vault.getAbstractFileByPath(target.path);
  if (!(file instanceof TFile)) return;
  const leaf = given ?? app.workspace.getLeaf(where);
  const heading = target.headings?.[target.headings.length - 1];
  if (file.extension === "pdf" && heading && /^Page \d+$/.test(heading)) {
    await app.workspace.openLinkText(`${file.path}#page=${heading.slice(5)}`, "", where);
    return;
  }
  if (file.extension !== "md") {
    await leaf.openFile(file);
    return;
  }
  if (target.offset !== undefined && target.length) {
    const content = await app.vault.cachedRead(file);
    if (target.offset + target.length <= content.length) {
      // Obsidian's own search uses this ephemeral state: it scrolls to the match and flashes it.
      await leaf.openFile(file, { eState: { match: { content, matches: [[target.offset, target.offset + target.length]] } } });
      return;
    }
  }
  if (heading) {
    await leaf.openFile(file, { eState: { subpath: `#${heading}` } });
    return;
  }
  if (target.offset !== undefined) {
    const content = await app.vault.cachedRead(file);
    const line = content.slice(0, target.offset).split("\n").length - 1;
    await leaf.openFile(file, { eState: { line } });
    return;
  }
  await leaf.openFile(file);
}

/** The `[[link]]` text for a path, following the user's link settings. */
export function linkFor(app: App, path: string, heading?: string, sourcePath = ""): string {
  const file = app.vault.getAbstractFileByPath(path);
  if (file instanceof TFile) return app.fileManager.generateMarkdownLink(file, sourcePath, heading ? `#${heading}` : undefined);
  return `[[${path.replace(/\.md$/, "")}${heading ? `#${heading}` : ""}]]`;
}

export function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export function showMenu(e: MouseEvent, build: (menu: Menu) => void): void {
  const menu = new Menu();
  build(menu);
  menu.showAtMouseEvent(e);
}

/** A banner with one action, used for engine-offline and partial-index states. */
export function banner(parent: HTMLElement, text: string, action?: { label: string; run: () => void }): HTMLElement {
  const el = parent.createDiv({ cls: "trova-banner" });
  el.createSpan({ text });
  if (action) el.createEl("button", { text: action.label }).addEventListener("click", action.run);
  return el;
}

/** Skeleton rows appear only if nothing has arrived after 150 ms. */
export function skeletonAfter(parent: HTMLElement, isStillPending: () => boolean, rows = 4): () => void {
  const timer = setTimeout(() => {
    if (!isStillPending()) return;
    const wrap = parent.createDiv({ cls: "trova-skeletons" });
    for (let i = 0; i < rows; i++) wrap.createDiv({ cls: "trova-skeleton" });
  }, 150);
  return () => clearTimeout(timer);
}

export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  return ((h2 >>> 0).toString(16) + (h1 >>> 0).toString(16)).padStart(16, "0");
}
