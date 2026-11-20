// Vault care: near-duplicates, orphan rescue and Rediscover, in an editor tab. These are periodic
// clean-up tasks for the whole vault; unlinked mentions of the active note live in the Connections
// pane. Three tiles show how much each task holds and switch between them; one task shows at a
// time. Every edit is an explicit user action with Undo, and "Not a duplicate" and "Keep unlinked"
// are remembered, so a dismissed item does not return with the next scan.

import { ItemView, TFile, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { ORPHAN_SUGGESTIONS, REDISCOVER_PER_DAY, REDISCOVER_RECENT_DAYS, REDISCOVER_STALE_DAYS, type DuplicatePair, type DuplicatesResponse, type Result } from "@trova/contract";
import { t } from "../i18n/en.js";
import { idle } from "../indexer.js";
import type TrovaPlugin from "../main.js";
import { pairKey } from "../settings.js";
import { banner, folderOf, linkFor, navigableInMainArea, onOpen, passEnterKeys, showMenu } from "../ui.js";

export const CARE_VIEW = "trova-care";
export type CareGroup = "duplicates" | "orphans" | "rediscover";
const TASKS: CareGroup[] = ["duplicates", "orphans", "rediscover"];
/** The most pairs and orphans one list draws; the rest are counted below it. */
const MAX_PAIRS = 200;
const MAX_ORPHANS = 300;
/** How long the Undo bar stays after an action. */
const UNDO_MS = 8000;

interface RediscoverItem {
  path: string;
  title: string;
  because: string;
  /** The recently opened note this one is strongly related to. */
  becausePath: string;
  days: number | null;
  snippet: string;
}

/**
 * Today's saved Rediscover pick, or null when there is none or any part of it does not fit; a new
 * pick then replaces it.
 */
function savedRediscover(plugin: TrovaPlugin): { day: string; items: RediscoverItem[] } | null {
  const saved = plugin.local.get<unknown>("rediscover");
  if (typeof saved !== "object" || saved === null) return null;
  const { day, items } = saved as { day?: unknown; items?: unknown };
  if (typeof day !== "string" || !Array.isArray(items)) return null;
  const ok = (i: unknown): i is RediscoverItem => {
    if (typeof i !== "object" || i === null) return false;
    const r = i as Record<string, unknown>;
    return typeof r["path"] === "string" && typeof r["title"] === "string" && typeof r["because"] === "string" && typeof r["becausePath"] === "string" && typeof r["snippet"] === "string" && (r["days"] === null || typeof r["days"] === "number");
  };
  return items.every(ok) ? { day, items } : null;
}

/** Rediscover: strong connections to recently opened notes that were not opened for a long time. */
async function pickRediscover(plugin: TrovaPlugin, signal?: AbortSignal): Promise<RediscoverItem[]> {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const saved = savedRediscover(plugin);
  if (saved?.day === today) return saved.items;
  if (!plugin.engine.ready) return [];
  const recent = plugin.local.recentPaths(40).filter((p) => (plugin.local.daysSinceOpened(p, now) ?? Infinity) <= REDISCOVER_RECENT_DAYS && p.endsWith(".md"));
  const picked = new Map<string, RediscoverItem>();
  for (const path of recent) {
    if (signal?.aborted || picked.size >= REDISCOVER_PER_DAY) break;
    await idle();
    const view = await plugin.connections.related({ kind: "note", path }, signal, 20).catch(() => null);
    if (!view || view.state !== "ok") continue;
    for (const r of view.results) {
      if (r.label !== "strong" || r.collection !== plugin.collection || picked.has(r.path) || plugin.isCareExcluded(r.path)) continue;
      const days = plugin.local.daysSinceOpened(r.path, now);
      const file = plugin.app.vault.getAbstractFileByPath(r.path);
      // A note never opened since the plugin was enabled counts when the file itself is old.
      const stale = days !== null ? days > REDISCOVER_STALE_DAYS : file instanceof TFile && (now - file.stat.mtime) / 86_400_000 > REDISCOVER_STALE_DAYS;
      if (!stale) continue;
      picked.set(r.path, { path: r.path, title: r.title, because: path.split("/").pop()!.replace(/\.md$/, ""), becausePath: path, days: days === null ? null : Math.floor(days), snippet: r.blocks?.[0]?.snippet ?? r.snippet });
      if (picked.size >= REDISCOVER_PER_DAY) break;
    }
  }
  const items = [...picked.values()];
  if (!signal?.aborted) plugin.local.set("rediscover", { day: today, items });
  return items;
}

/** How long ago a note was last opened, in the largest whole unit: "12 days", "8 months", "2 years". */
export function agoText(days: number): string {
  const unit = (n: number, u: Intl.RelativeTimeFormatUnit) => new Intl.NumberFormat(undefined, { style: "unit", unit: u, unitDisplay: "long" }).format(n);
  if (days < 30) return unit(Math.max(1, Math.round(days)), "day");
  if (days < 365) return unit(Math.round(days / 30.44), "month");
  return unit(Math.round(days / 365.25), "year");
}

/** "3 minutes ago" style text for a past time, in the user's language settings. */
export function sinceText(at: number, now = Date.now()): string {
  const minutes = Math.round((now - at) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(minutes) < 60) return rtf.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return rtf.format(-hours, "hour");
  return rtf.format(-Math.round(hours / 24), "day");
}

/**
 * The near-duplicate pairs to show, and those the user marked "Not a duplicate". A pair inside one
 * note, which the scan can report for two of its sections, counts like any other.
 */
export function splitPairs(pairs: DuplicatePair[], dismissed: (a: string, b: string) => boolean): { active: DuplicatePair[]; dismissed: DuplicatePair[] } {
  const active: DuplicatePair[] = [];
  const off: DuplicatePair[] = [];
  for (const p of pairs) (dismissed(p.a, p.b) ? off : active).push(p);
  return { active, dismissed: off };
}

/**
 * A short excerpt of a note or section for a pair card: without front matter or a leading
 * heading, whitespace collapsed, cut at a word near `max` characters.
 */
export function excerpt(content: string, max = 160): string {
  let text = content.replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/^\s*#{1,6}\s[^\n]*\n?/, "");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The title shown for a pair side or an orphan: the file name without `.md`. */
function titleOf(path: string): string {
  return path.split("/").pop()!.replace(/\.md$/, "");
}

const TILE: Record<CareGroup, { icon: string; label: () => string; describe: () => string }> = {
  duplicates: { icon: "copy", label: () => t("careTileDuplicates"), describe: () => t("careDescDuplicates") },
  orphans: { icon: "unlink", label: () => t("careTileOrphans"), describe: () => t("careDescOrphans") },
  rediscover: { icon: "history", label: () => t("careTileRediscover"), describe: () => t("careDescRediscover") },
};

export class VaultCareView extends ItemView {
  private task: CareGroup = "duplicates";
  private pageEl!: HTMLElement;
  /** A scroll position from Back or a restored layout, applied once the list has rendered. */
  private pendingScroll: number | null = null;
  /** The list being drawn, so a scroll position that arrives during the drawing waits for it. */
  private rendering: Promise<void> | null = null;
  /** The pair the near-duplicate link jumped to, kept in the state so Forward returns to it. */
  private pair: string | null = null;
  private summaryEl!: HTMLElement;
  private scanEl!: HTMLElement;
  private tilesEl!: HTMLElement;
  private undoEl!: HTMLElement;
  private descEl!: HTMLElement;
  private listEl!: HTMLElement;
  private abort: AbortController | null = null;
  private pollTimer: number | null = null;
  private undoTimer: number | null = null;
  private duplicates: DuplicatesResponse | null = null;
  private orphans: string[] | null = null;
  private rediscoverCount: number | null = null;
  private showDismissed = false;
  private snippets = new Map<string, string>();
  private observer: IntersectionObserver | null = null;
  /** Orphans whose suggested links are wanted, in the order they came into view. */
  private suggestQueue: { path: string; el: HTMLElement }[] = [];
  private suggesting = false;
  /** False until the first counts are in; until then near-duplicates says it is loading. */
  private loaded = false;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: TrovaPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return CARE_VIEW;
  }
  getDisplayText(): string {
    return t("careTitle");
  }
  override getIcon(): string {
    return "heart-pulse";
  }

  override async onOpen(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.addClass("trova-pane", "trova-care");
    navigableInMainArea(this);
    passEnterKeys(this);
    const page = (this.pageEl = el.createDiv({ cls: "trova-care-page" }));
    const head = page.createDiv({ cls: "trova-care-header" });
    const title = head.createDiv({ cls: "trova-care-title" });
    setIcon(title.createSpan({ cls: "trova-care-title-icon", attr: { "aria-hidden": "true" } }), "heart-pulse");
    title.createEl("h2", { text: t("careTitle") });
    this.summaryEl = head.createDiv({ cls: "trova-care-summary" });
    this.scanEl = head.createDiv({ cls: "trova-care-scan" });
    this.tilesEl = page.createDiv({ cls: "trova-care-tiles", attr: { role: "tablist" } });
    this.undoEl = page.createDiv({ cls: "trova-care-undo", attr: { role: "status", "aria-live": "polite" } });
    this.descEl = page.createDiv({ cls: "trova-care-desc" });
    this.listEl = page.createDiv({ cls: "trova-care-list", attr: { role: "tabpanel", id: "trova-care-panel" } });
    const saved = this.plugin.local.get<CareGroup>("care-tab");
    if (saved && TASKS.includes(saved)) this.task = saved;
    this.observer = new IntersectionObserver((entries) => this.onVisible(entries), { root: null, rootMargin: "200px" });
    this.register(this.plugin.store.onChange(() => this.renderTiles()));
    this.renderTiles();
    this.renderHeader();
    void this.renderTask();
    void this.loadCounts().then(() => this.renderTask());
  }

  override async onClose(): Promise<void> {
    this.abort?.abort();
    this.observer?.disconnect();
    if (this.pollTimer) window.clearTimeout(this.pollTimer);
    if (this.undoTimer) window.clearTimeout(this.undoTimer);
  }

  // The group, the pair the near-duplicate link jumped to, and the scroll position are kept in the
  // tab's history and layout, so Back, Forward and a restart bring Vault care back as it was.
  override getState(): Record<string, unknown> {
    return { ...super.getState(), group: this.task, ...(this.pair ? { pair: this.pair } : {}) };
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    const s = (state ?? {}) as { group?: unknown; pair?: unknown };
    if (!TASKS.includes(s.group as CareGroup)) return;
    const pair = typeof s.pair === "string" ? s.pair : null;
    // A jump to a pair is navigation, so Back returns to where it came from. Obsidian ignores the
    // flag while it moves through the history itself.
    if (pair && (s.group !== this.task || pair !== this.pair)) result.history = true;
    this.setTask(s.group as CareGroup);
    this.pair = pair;
    if (pair) this.flashPair(pair);
  }

  override getEphemeralState(): Record<string, unknown> {
    return { ...super.getEphemeralState(), scroll: this.pageEl?.scrollTop ?? 0 };
  }

  override setEphemeralState(state: unknown): void {
    super.setEphemeralState(state);
    const scroll = (state as { scroll?: unknown } | null)?.scroll;
    if (typeof scroll !== "number" || !Number.isFinite(scroll)) return;
    this.pendingScroll = scroll;
    // Back within the view redraws the list before Obsidian passes the scroll position.
    const drawing = this.rendering;
    void drawing?.then(() => drawing === this.rendering && this.applyScroll());
  }

  private applyScroll(): void {
    if (!this.loaded || this.pendingScroll === null) return;
    this.pageEl.scrollTop = this.pendingScroll;
    this.pendingScroll = null;
  }

  /** Shows one task and focuses its tile, for the "Open Rediscover" command and the arrow keys. */
  focusGroup(task: CareGroup): void {
    this.setTask(task);
    this.tilesEl.querySelector<HTMLElement>(`[data-task="${task}"]`)?.focus();
  }

  private setTask(task: CareGroup): void {
    if (task === this.task) return;
    this.task = task;
    this.pair = null;
    this.showDismissed = false;
    this.plugin.local.set("care-tab", task);
    this.renderTiles();
    void this.renderTask();
  }

  // ---------- counts and header ----------

  private async loadCounts(): Promise<void> {
    await Promise.all([this.loadDuplicates(), this.loadOrphans()]);
    this.loaded = true;
    const today = new Date().toISOString().slice(0, 10);
    const saved = savedRediscover(this.plugin);
    if (saved?.day === today) this.rediscoverCount = saved.items.length;
    this.renderTiles();
  }

  private async loadDuplicates(): Promise<void> {
    if (!this.plugin.engine.ready) return;
    this.duplicates = await this.plugin.engine.duplicates(false).catch(() => null);
    this.renderHeader();
    if (this.duplicates?.state === "running") {
      if (this.pollTimer) window.clearTimeout(this.pollTimer);
      this.pollTimer = window.setTimeout(() => {
        void this.loadDuplicates().then(() => {
          this.renderTiles();
          if (this.task === "duplicates") void this.renderTask();
        });
      }, 1500);
    }
  }

  private async loadOrphans(): Promise<void> {
    const all = await this.plugin.worker.call("orphans", []).catch(() => [] as string[]);
    this.orphans = all.filter((p) => !this.plugin.isCareExcluded(p)).sort();
  }

  private pairs(): { active: DuplicatePair[]; dismissed: DuplicatePair[] } {
    const store = this.plugin.store;
    return splitPairs(this.duplicates?.pairs ?? [], (a, b) => store.isNotDuplicate(a, b));
  }

  private orphanLists(): { active: string[]; kept: string[] } {
    const store = this.plugin.store;
    const all = this.orphans ?? [];
    const kept = (p: string) => store.isKeptUnlinked(this.plugin.sourceId(p));
    return { active: all.filter((p) => !kept(p)), kept: all.filter(kept) };
  }

  private renderHeader(): void {
    const count = this.app.vault.getMarkdownFiles().length;
    const parts = [t("careNotes", { n: count.toLocaleString() })];
    if (this.duplicates?.computedAt) parts.push(t("careChecked", { when: sinceText(this.duplicates.computedAt) }));
    this.summaryEl.setText(parts.join(" · "));
    this.scanEl.empty();
    if (!this.plugin.engine.ready) return;
    const data = this.duplicates;
    const progress = this.plugin.engine.snapshot.progress;
    const running = data?.state === "running";
    const button = this.scanEl.createEl("button", { cls: "trova-care-scan-button" });
    setIcon(button.createSpan({ attr: { "aria-hidden": "true" } }), "refresh-cw");
    button.appendText(running ? t("scanning", { done: progress?.done ?? 0, total: progress?.total ?? 0 }) : data?.computedAt ? t("rescan") : t("scan"));
    button.disabled = running;
    if (running) button.addClass("is-running");
    button.addEventListener("click", () => void this.plugin.engine.duplicates(true).then(() => this.loadDuplicates()).then(() => this.renderTask()));
  }

  private renderTiles(): void {
    const el = this.tilesEl;
    el.empty();
    const pairs = this.duplicates ? this.pairs().active.length : null;
    const orphans = this.orphans ? this.orphanLists().active.length : null;
    const counts: Record<CareGroup, number | null> = { duplicates: pairs, orphans, rediscover: this.rediscoverCount };
    for (const task of TASKS) {
      const on = task === this.task;
      const tile = el.createEl("button", {
        cls: `trova-care-tile trova-care-tile-${task}${on ? " is-active" : ""}`,
        attr: { role: "tab", "aria-selected": String(on), "aria-controls": "trova-care-panel", tabindex: on ? "0" : "-1", "data-task": task },
      });
      setIcon(tile.createSpan({ cls: "trova-care-tile-icon", attr: { "aria-hidden": "true" } }), TILE[task].icon);
      const text = tile.createSpan({ cls: "trova-care-tile-text" });
      text.createSpan({ cls: "trova-care-tile-count", text: counts[task] === null ? "–" : counts[task]!.toLocaleString() });
      text.createSpan({ cls: "trova-care-tile-label", text: TILE[task].label() });
      tile.addEventListener("click", () => this.setTask(task));
    }
    // Tabs move with the arrow keys; Tab stops on the selected tile only.
    el.onkeydown = (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const at = TASKS.indexOf(this.task);
      this.focusGroup(TASKS[(at + (e.key === "ArrowRight" ? 1 : -1) + TASKS.length) % TASKS.length]!);
    };
  }

  /** The bar that confirms an action, with Undo. A new action replaces it. */
  private confirm(text: string, undo: () => void): void {
    const el = this.undoEl;
    el.empty();
    if (this.undoTimer) window.clearTimeout(this.undoTimer);
    const bar = el.createDiv({ cls: "trova-care-undo-bar" });
    setIcon(bar.createSpan({ cls: "trova-care-undo-icon", attr: { "aria-hidden": "true" } }), "check");
    bar.createSpan({ cls: "trova-care-undo-text", text });
    bar.createEl("button", { cls: "trova-link-button", text: t("undo") }).addEventListener("click", () => {
      el.empty();
      undo();
    });
    this.undoTimer = window.setTimeout(() => el.empty(), UNDO_MS);
  }

  private renderTask(): Promise<void> {
    return (this.rendering = this.drawTask());
  }

  private async drawTask(): Promise<void> {
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    this.observer?.disconnect();
    this.suggestQueue = [];
    this.descEl.setText(TILE[this.task].describe());
    this.listEl.empty();
    if (this.task === "duplicates") this.renderDuplicates();
    else if (this.task === "orphans") await this.renderOrphans(abort.signal);
    else await this.renderRediscover(abort.signal);
    if (!abort.signal.aborted) this.applyScroll();
  }

  private empty(icon: string, text: string): HTMLElement {
    const box = this.listEl.createDiv({ cls: "trova-care-empty" });
    setIcon(box.createSpan({ cls: "trova-care-empty-icon", attr: { "aria-hidden": "true" } }), icon);
    box.createDiv({ text });
    return box;
  }

  private engineBanner(): boolean {
    if (this.plugin.engine.ready) return false;
    banner(this.listEl, t("needsEngine"), this.plugin.engine.snapshot.state === "disabled" ? undefined : { label: t("startEngine"), run: () => void this.plugin.engine.connect(true).then(() => this.loadCounts()).then(() => this.renderHeader()).then(() => this.renderTask()) });
    return true;
  }

  // ---------- near-duplicates ----------

  private renderDuplicates(): void {
    if (this.engineBanner()) return;
    // Before the last scan's pairs arrive, "run a scan" would be wrong.
    if (!this.loaded) return void this.listEl.createDiv({ cls: "trova-care-meta", text: t("careLoading") });
    const data = this.duplicates;
    if (!data || (!data.computedAt && data.state !== "running")) {
      const box = this.empty("copy", t("duplicatesNeverRun"));
      if (data?.state !== "running") box.createEl("button", { cls: "mod-cta", text: t("scan") }).addEventListener("click", () => void this.plugin.engine.duplicates(true).then(() => this.loadDuplicates()).then(() => this.renderTask()));
      return;
    }
    const { active, dismissed } = this.pairs();
    if (active.length === 0) this.empty("circle-check", t("duplicatesEmpty"));
    for (const pair of active.slice(0, MAX_PAIRS)) this.renderPair(pair);
    const foot = this.listEl.createDiv({ cls: "trova-care-foot" });
    foot.createSpan({ text: active.length > MAX_PAIRS ? t("morePairs", { n: active.length - MAX_PAIRS }) : "" });
    if (dismissed.length) {
      foot.createEl("button", { cls: "trova-link-button", text: this.showDismissed ? t("hideDismissed") : t("showDismissed", { n: dismissed.length }) }).addEventListener("click", () => {
        this.showDismissed = !this.showDismissed;
        void this.renderTask();
      });
      if (this.showDismissed) {
        const list = this.listEl.createDiv({ cls: "trova-care-dismissed" });
        for (const p of dismissed) {
          const row = list.createDiv({ cls: "trova-care-dismissed-row" });
          row.createSpan({ text: `${p.aTitle} ↔ ${p.bTitle}` });
          row.createEl("button", { cls: "trova-link-button", text: t("restore") }).addEventListener("click", () => {
            this.plugin.store.setNotDuplicate(p.a, p.b, false);
            void this.renderTask();
          });
        }
      }
    }
  }

  /**
   * A pair card: the similarity and the two quiet actions on top; the two notes as boxes with
   * their text; and Compare, the main action, as the round button between them.
   */
  private renderPair(pair: DuplicatePair): void {
    const card = this.listEl.createDiv({ cls: "trova-care-card trova-care-pair", attr: { "data-pair": pairKey(pair.a, pair.b) } });
    const top = card.createDiv({ cls: "trova-care-pair-top" });
    top.createSpan({ cls: "trova-care-pill", text: t("similarity", { pct: Math.round(pair.similarity * 100) }) });
    top.createSpan({ cls: "trova-care-meta", text: pair.kind === "block" ? t("kindSections") : t("kindWholeNotes") });
    const quiet = top.createDiv({ cls: "trova-care-quiet" });
    this.quiet(quiet, "eye-off", t("notDuplicate"), () => {
      this.plugin.store.setNotDuplicate(pair.a, pair.b, true);
      void this.renderTask();
      this.confirm(t("markedNotDuplicate", { a: pair.aTitle, b: pair.bTitle }), () => {
        this.plugin.store.setNotDuplicate(pair.a, pair.b, false);
        void this.renderTask();
      });
    });
    this.quiet(quiet, "link", t("linkThem"), () => void this.appendLink(pair.aPath, pair.bPath));
    const cols = card.createDiv({ cls: "trova-care-pair-cols" });
    const side = (id: string, path: string, title: string) => {
      const el = cols.createDiv({ cls: "trova-care-note trova-care-side", attr: { tabindex: "0", role: "link" } });
      el.createDiv({ cls: "trova-care-card-title", text: title });
      const heading = id.includes("#") ? id.slice(id.lastIndexOf("#") + 1) : "";
      el.createDiv({ cls: "trova-care-meta", text: [folderOf(path) || "/", heading].filter(Boolean).join(" › ") });
      this.snippetSlot(el, id, "trova-care-snippet");
      onOpen(el, (where) => void this.plugin.openById(id, where));
    };
    side(pair.a, pair.aPath, pair.aTitle);
    const mid = cols.createDiv({ cls: "trova-care-pair-mid" });
    const compare = mid.createEl("button", { cls: "trova-care-compare", attr: { "aria-label": t("compareSideBySide") } });
    setIcon(compare, "columns-2");
    compare.addEventListener("click", () => void this.plugin.compare(pair.a, pair.b));
    mid.createSpan({ cls: "trova-care-compare-label", text: t("compare"), attr: { "aria-hidden": "true" } });
    side(pair.b, pair.bPath, pair.bTitle);
  }

  /** A text snippet that loads when its container comes into view. */
  private snippetSlot(container: HTMLElement, id: string, cls: string): void {
    const snippet = container.createDiv({ cls, attr: { "data-snippet-text": "" } });
    const known = this.snippets.get(id);
    if (known !== undefined) return void snippet.setText(known);
    // An empty snippet is hidden, and a hidden element never comes into view, so the visible
    // container is what the observer watches.
    container.dataset["snippet"] = id;
    this.observer?.observe(container);
  }

  /** A low-key text button with an icon, for the actions that are not the main one. */
  private quiet(parent: HTMLElement, icon: string, label: string, run: () => void): HTMLButtonElement {
    const b = parent.createEl("button", { cls: "trova-care-quiet-button" });
    setIcon(b.createSpan({ attr: { "aria-hidden": "true" } }), icon);
    b.appendText(label);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      run();
    });
    return b;
  }

  /** Loads the excerpts of pair sides as they come into view. */
  private onVisible(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target as HTMLElement;
      this.observer?.unobserve(el);
      const id = el.dataset["snippet"];
      if (id) {
        void this.plugin.engine.get({ id }).then(
          (doc) => {
            const text = excerpt(doc.content);
            this.snippets.set(id, text);
            el.querySelector("[data-snippet-text]")?.setText(text);
          },
          () => this.snippets.set(id, ""),
        );
      }
      const path = el.dataset["orphan"];
      if (path) {
        this.suggestQueue.push({ path, el });
        void this.drainSuggestions();
      }
    }
  }

  /** Appends a link to `toPath` at the end of `fromPath`: one note, one line, with Undo. */
  private async appendLink(fromPath: string, toPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(fromPath);
    if (!(file instanceof TFile) || file.extension !== "md") return;
    let before = "";
    await this.app.vault.process(file, (content) => {
      before = content;
      return `${content.replace(/\s*$/, "")}\n\n${linkFor(this.app, toPath, undefined, fromPath)}\n`;
    });
    this.confirm(t("linkedTo", { from: titleOf(fromPath), to: titleOf(toPath) }), () => void this.app.vault.modify(file, before));
  }

  // ---------- orphans ----------

  private async renderOrphans(signal: AbortSignal): Promise<void> {
    if (!this.orphans) await this.loadOrphans();
    if (signal.aborted) return;
    this.renderTiles();
    const { active, kept } = this.orphanLists();
    if (!this.plugin.engine.ready && active.length) banner(this.listEl, t("needsEngine"));
    if (active.length === 0) this.empty("circle-check", t("orphansEmpty"));
    // An orphan that is also one side of a near-duplicate pair is often a stray copy.
    const inPair = new Map<string, DuplicatePair>();
    for (const p of this.pairs().active) {
      inPair.set(p.aPath, p);
      inPair.set(p.bPath, p);
    }
    const rows = active.length ? this.listEl.createDiv({ cls: "trova-care-rows", attr: { role: "list" } }) : null;
    for (const path of active.slice(0, MAX_ORPHANS)) this.renderOrphan(rows!, path, inPair.get(path));
    const foot = this.listEl.createDiv({ cls: "trova-care-foot" });
    foot.createSpan({ text: active.length > MAX_ORPHANS ? t("moreOrphans", { n: active.length - MAX_ORPHANS }) : "" });
    if (kept.length) {
      foot.createEl("button", { cls: "trova-link-button", text: this.showDismissed ? t("hideDismissed") : t("showKept", { n: kept.length }) }).addEventListener("click", () => {
        this.showDismissed = !this.showDismissed;
        void this.renderTask();
      });
      if (this.showDismissed) {
        const list = this.listEl.createDiv({ cls: "trova-care-dismissed" });
        for (const path of kept) {
          const row = list.createDiv({ cls: "trova-care-dismissed-row" });
          row.createSpan({ text: titleOf(path) });
          row.createEl("button", { cls: "trova-link-button", text: t("restore") }).addEventListener("click", () => {
            this.plugin.store.setKeptUnlinked(this.plugin.sourceId(path), false);
            void this.renderTask();
          });
        }
      }
    }
  }

  /**
   * An orphan row: an icon, the title, folder and a one-line snippet, the best suggested link as a
   * split button (its arrow lists the other suggestions), and "Keep unlinked".
   */
  private renderOrphan(list: HTMLElement, path: string, pair: DuplicatePair | undefined): void {
    // Three lines on one left edge: the title with the folder (and, at the right end, the
    // near-duplicate tag), the snippet, then the actions. Buttons never share a line with text.
    const row = list.createDiv({ cls: "trova-care-orow", attr: { role: "listitem" } });
    setIcon(row.createSpan({ cls: "trova-care-oicon", attr: { "aria-hidden": "true" } }), "unlink");
    const col = row.createDiv({ cls: "trova-care-ocol" });
    const top = col.createDiv({ cls: "trova-care-otop" });
    const name = top.createDiv({ cls: "trova-care-oname trova-care-side", attr: { tabindex: "0", role: "link" } });
    name.createSpan({ cls: "trova-care-card-title", text: titleOf(path) });
    name.createSpan({ cls: "trova-care-meta", text: ` · ${folderOf(path) || "/"}` });
    onOpen(name, (where) => void this.plugin.open({ path }, where));
    if (pair) {
      const tag = top.createEl("button", { cls: "trova-care-tag", text: `${t("alsoDuplicate")} ›`, attr: { "aria-label": `${t("alsoDuplicate")}: ${t("viewPair")}` } });
      tag.addEventListener("click", () => void this.showPair(pair));
    }
    this.snippetSlot(col, this.plugin.sourceId(path), "trova-care-osnippet");
    const actions = col.createDiv({ cls: "trova-care-oactions" });
    const slot = actions.createDiv({ cls: "trova-care-oslot", attr: { "data-orphan": path } });
    slot.createSpan({ cls: "trova-care-meta", text: this.plugin.engine.ready ? t("findingLink") : "" });
    if (this.plugin.engine.ready) this.observer?.observe(slot);
    this.quiet(actions, "eye-off", t("keepUnlinked"), () => {
      const source = this.plugin.sourceId(path);
      this.plugin.store.setKeptUnlinked(source, true);
      void this.renderTask();
      this.confirm(t("keptUnlinked", { title: titleOf(path) }), () => {
        this.plugin.store.setKeptUnlinked(source, false);
        void this.renderTask();
      });
    });
  }

  /**
   * The near-duplicate link: shows the pair through the tab's state, so Back returns to the orphan
   * list. Focus moves to the near-duplicates tile, as the link's own button is redrawn away.
   */
  private async showPair(pair: DuplicatePair): Promise<void> {
    await this.leaf.setViewState({ type: CARE_VIEW, active: true, state: { group: "duplicates", pair: pairKey(pair.a, pair.b) } });
    this.tilesEl.querySelector<HTMLElement>('[data-task="duplicates"]')?.focus();
  }

  private flashPair(key: string): void {
    // The duplicates list renders synchronously, so the pair's card exists now.
    const target = this.listEl.querySelector<HTMLElement>(`[data-pair="${CSS.escape(key)}"]`);
    target?.scrollIntoView({ block: "center" });
    target?.addClass("is-flash");
    window.setTimeout(() => target?.removeClass("is-flash"), 1600);
  }

  /** Loads suggested links one orphan at a time, between frames, for orphans in view. */
  private async drainSuggestions(): Promise<void> {
    if (this.suggesting) return;
    this.suggesting = true;
    const signal = this.abort?.signal;
    try {
      while (this.suggestQueue.length && !signal?.aborted) {
        const { path, el } = this.suggestQueue.shift()!;
        await idle();
        const view = await this.plugin.connections.related({ kind: "note", path }, signal, 10).catch(() => null);
        if (signal?.aborted) return;
        const top = (view?.results ?? []).filter((r) => r.collection === this.plugin.collection && r.path.endsWith(".md")).slice(0, ORPHAN_SUGGESTIONS);
        this.renderSuggestions(el, path, top);
      }
    } finally {
      this.suggesting = false;
    }
  }

  private renderSuggestions(el: HTMLElement, orphan: string, top: Result[]): void {
    el.empty();
    if (top.length === 0) return void el.createSpan({ cls: "trova-care-meta", text: t("noSuggestion") });
    const split = el.createDiv({ cls: "trova-care-split" });
    // A long note name is cut with "…" to fit the row; the tooltip and the screen reader get it whole.
    const label = t("linkTo", { title: top[0]!.title });
    const main = split.createEl("button", { cls: "trova-care-split-main", attr: { title: label } });
    setIcon(main.createSpan({ attr: { "aria-hidden": "true" } }), "link");
    main.createSpan({ cls: "trova-care-split-text", text: label });
    const link = (r: Result) => {
      split.querySelectorAll("button").forEach((b) => (b.disabled = true));
      void this.appendLink(orphan, r.path);
    };
    main.addEventListener("click", () => link(top[0]!));
    const rest = top.slice(1);
    if (!rest.length) return;
    const more = split.createEl("button", { cls: "trova-care-split-more", attr: { "aria-label": t("moreSuggestions", { n: rest.length }), "aria-haspopup": "menu" } });
    setIcon(more, "chevron-down");
    more.addEventListener("click", (e) =>
      showMenu(e, (menu) => {
        for (const r of rest) menu.addItem((i) => i.setTitle(t("linkTo", { title: r.title })).setIcon("link").onClick(() => link(r)));
      }),
    );
  }

  // ---------- rediscover ----------

  private async renderRediscover(signal: AbortSignal): Promise<void> {
    if (!this.plugin.settings.rediscover) {
      const box = this.empty("history", t("rediscoverOff"));
      box.createEl("button", { text: t("openSetting") }).addEventListener("click", () => this.plugin.openSettings());
      return;
    }
    if (this.engineBanner()) return;
    const loading = this.listEl.createDiv({ cls: "trova-care-meta", text: t("findingRediscover") });
    const items = await pickRediscover(this.plugin, signal);
    if (signal.aborted) return;
    loading.remove();
    this.rediscoverCount = items.length;
    this.renderTiles();
    if (items.length === 0) return void this.empty("history", t("rediscoverEmpty"));
    const grid = this.listEl.createDiv({ cls: "trova-care-rediscover", attr: { role: "list" } });
    for (const item of items) this.renderRediscoverCard(grid, item);
  }

  /**
   * A note to rediscover: how long since it was last opened, its text, and the recently opened
   * note it is strongly related to, as a chip that opens that note. "Open beside" opens it in a
   * split next to the note being worked on.
   */
  private renderRediscoverCard(grid: HTMLElement, item: RediscoverItem): void {
    const card = grid.createDiv({ cls: "trova-care-card trova-care-redis", attr: { role: "listitem" } });
    const head = card.createDiv({ cls: "trova-care-redis-head" });
    setIcon(head.createSpan({ cls: "trova-care-rediscover-icon", attr: { "aria-hidden": "true" } }), "history");
    const name = head.createDiv({ cls: "trova-care-redis-name trova-care-side", attr: { tabindex: "0", role: "link" } });
    name.createDiv({ cls: "trova-care-card-title", text: item.title });
    name.createDiv({ cls: "trova-care-meta", text: folderOf(item.path) || "/" });
    onOpen(name, (where) => void this.plugin.open({ path: item.path }, where));
    head.createSpan({ cls: "trova-care-redis-age", text: item.days === null ? t("notOpenedYet") : agoText(item.days) });
    if (item.snippet) card.createDiv({ cls: "trova-care-redis-snippet", text: excerpt(item.snippet, 220) });
    const foot = card.createDiv({ cls: "trova-care-redis-foot" });
    const why = foot.createDiv({ cls: "trova-care-redis-why" });
    why.createSpan({ cls: "trova-care-meta", text: t("relatedToRecent") });
    const chip = why.createEl("button", { cls: "trova-care-chip" });
    setIcon(chip.createSpan({ attr: { "aria-hidden": "true" } }), "file-text");
    chip.appendText(item.because);
    onOpen(chip, (where) => void this.plugin.open({ path: item.becausePath }, where));
    this.quiet(foot, "columns-2", t("openBeside"), () => void this.plugin.openBeside(this.plugin.sourceId(item.path), { besidePath: item.becausePath, reuse: true }));
  }
}
