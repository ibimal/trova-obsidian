// Ask inside the Connections pane: question-first search. Keyword hits appear first, vector
// results fuse in, and in Deep mode a rerank pass reorders the top results once. "More like this"
// shows a block's related blocks in the same list.

import { MarkdownView, Notice, setIcon } from "obsidian";
import { ASK_STOPWORDS, labelForRank, parseQuery, pickAskMode, type AskRequest, type DocumentBody, type Lane, type ParsedQuery, type Result, type ResultBatch } from "@trova/contract";
import { fromWorker, fuseLanes } from "../query/controller.js";
import { EngineOffline } from "../engine/manager.js";
import { t } from "../i18n/en.js";
import type TrovaPlugin from "../main.js";
import { ConfirmModal, banner, folderOf, onOpen, quietLabel, reducedMotion, renderBadges, renderHighlighted, showMenu, skeletonAfter, type OpenIn } from "../ui.js";

export type AskMode = "auto" | "fast" | "deep";

/** What a row needs from the pane: shared keyboard, hover and selection behaviour. */
export interface RowWiring {
  path: string;
  open(where: OpenIn): void;
  insertLink(): void;
  menu(e: MouseEvent): void;
  expand?(open: boolean): void;
  /** Shows or hides the row's details, for the `i` key. */
  toggle?(): void;
}

export interface AskHost {
  listEl(): HTMLElement;
  /** Re-renders the pane after the session changed. */
  changed(): void;
  wireRow(el: HTMLElement, wiring: RowWiring): void;
  selectedPath(): string | null;
}

/** How many answers Ask asks the engine for. */
export const ASK_ANSWERS = 20;

/** Questions shorter than this do not run while the user types; Enter still runs them. */
const PREVIEW_MIN_CHARS = 3;
const PREVIEW_DELAY_MS = 250;
/** "Rerank now" gives Deep mode this long, instead of the time limit in the settings. */
const RERANK_RETRY_MS = 120_000;

/**
 * Whether pressing Enter would run a Deep search for a question: Deep is selected, or Auto is and
 * the question has a question's shape. The typing preview always runs Fast, so this decides
 * whether the pane offers a Deep search for the preview's question.
 */
export function deepOnEnter(question: string, mode: AskMode): boolean {
  if (!question.trim()) return false;
  if (mode === "deep") return true;
  if (mode === "fast") return false;
  return pickAskMode(parseQuery(question, { mode: "ask" }).query) === "deep";
}

/** Whether "Rerank now" is idle, running, or failed for the current question. */
export type RerankRetry = "idle" | "running" | "failed";

/** "Rerank now" is offered only for a typed question whose Deep pass ran out of time. */
export function canRerankNow(question: string, note: ResultBatch["note"], retry: RerankRetry): boolean {
  return question !== "" && note === "rerank_skipped" && retry !== "running";
}

export class AskSession {
  mode: AskMode;
  explain = false;
  question = "";
  /** A readable name for a question the user did not type, such as "About this note". */
  label = "";
  results: Result[] = [];
  private abort: AbortController | null = null;
  private stage: ResultBatch["stage"] | null = null;
  final = true;
  private note: ResultBatch["note"];
  private ranMode: "fast" | "deep" | undefined;
  private expansions: { type: Lane; query: string }[] = [];
  private neighbours = new Map<string, DocumentBody>();
  private error: string | null = null;
  /** True when the shown results came from the worker's keyword index because the engine is off. */
  private keywordOnly = false;
  private previewTimer: number | null = null;
  /** True while the answers shown came from the typing preview, not from pressing Enter. */
  previewed = false;
  /**
   * True while a typing preview still shows the previous question's answers: they stay until the
   * new question's first batch arrives, so the list does not blank on every pause in typing.
   */
  private carried = false;
  retry: RerankRetry = "idle";

  constructor(
    private plugin: TrovaPlugin,
    private host: AskHost,
  ) {
    this.mode = plugin.settings.askMode;
  }

  /** True while the pane shows answers instead of related notes. */
  get active(): boolean {
    return this.question !== "" || this.stage !== null;
  }

  get count(): number {
    return this.results.length;
  }

  /** Clears the question; the pane goes back to related notes. */
  clear(): void {
    this.cancelPreview();
    this.abort?.abort();
    this.abort = null;
    this.question = "";
    this.label = "";
    this.results = [];
    this.stage = null;
    this.final = true;
    this.note = undefined;
    this.retry = "idle";
    this.previewed = false;
    this.carried = false;
    this.ranMode = undefined;
    this.expansions = [];
    this.error = null;
    this.keywordOnly = false;
    this.neighbours.clear();
  }

  dispose(): void {
    this.cancelPreview();
    this.abort?.abort();
  }

  /** Runs a question as the user types: Fast mode, after a short pause, and not saved to history. */
  preview(raw: string): void {
    this.cancelPreview();
    const text = raw.trim();
    if (text.length < PREVIEW_MIN_CHARS) return;
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      void this.run(text, { mode: "fast", record: false, preview: true });
    }, PREVIEW_DELAY_MS);
  }

  cancelPreview(): void {
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    this.previewTimer = null;
  }

  /** Runs a question. A new run aborts the previous one before it starts. */
  async run(raw: string, opts: { mode?: AskMode; record?: boolean; label?: string; preview?: boolean } = {}): Promise<void> {
    this.cancelPreview();
    const question = raw.trim().replace(/^\?\s*/, "");
    this.abort?.abort();
    if (!question) return;
    const abort = new AbortController();
    this.abort = abort;
    this.question = question;
    this.label = opts.label ?? "";
    this.carried = opts.preview === true && this.results.length > 0;
    if (!this.carried) this.results = [];
    this.stage = null;
    this.final = false;
    this.note = undefined;
    this.retry = "idle";
    this.previewed = opts.preview === true;
    this.ranMode = undefined;
    this.expansions = [];
    this.error = null;
    this.neighbours.clear();
    this.keywordOnly = false;
    const mode = opts.mode ?? this.mode;
    if (opts.record !== false) this.plugin.local.addHistory({ query: question, mode, at: Date.now() });
    this.host.changed();
    if (!this.plugin.engine.ready) {
      await this.keywordFallback(question, abort.signal);
      return;
    }
    const cancelSkeleton = skeletonAfter(this.host.listEl(), () => !this.final && this.results.length === 0 && !abort.signal.aborted);
    try {
      const query = parseQuery(question, { mode: "ask", knownKeys: this.plugin.knownKeys() }).query;
      // Auto is resolved here with the engine's own rule, so the Deep hint and the search always
      // agree on the mode. History keeps "auto".
      const sent = mode === "auto" ? pickAskMode(query) : mode;
      const req: AskRequest = { query, mode: sent, collections: this.plugin.engine.collections(), limit: ASK_ANSWERS, fuzzy: this.plugin.settings.typoTolerance > 0, deadlineMs: this.plugin.settings.askDeepSeconds * 1000 };
      for await (const batch of this.plugin.engine.ask(req, abort.signal)) {
        if (abort.signal.aborted) return;
        this.applyBatch(batch);
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      this.error = err instanceof EngineOffline ? "offline" : (err as Error).message;
    } finally {
      cancelSkeleton();
    }
    if (abort.signal.aborted) return;
    // Answers carried over from the previous question never stand in for this one's.
    if (this.carried) {
      this.carried = false;
      this.results = [];
    }
    if (this.error === "offline" && this.results.length === 0) return this.keywordFallback(question, abort.signal);
    this.final = true;
    this.host.changed();
  }

  /**
   * Without the engine, Ask still answers from the worker's keyword index: all the question's
   * content words first, then any of them when that finds fewer than three notes.
   */
  private async keywordFallback(question: string, signal: AbortSignal): Promise<void> {
    const { plugin } = this;
    // The fallback sets its own results, so nothing carried over from a preview remains.
    this.carried = false;
    const parsed = parseQuery(question, { mode: "ask", knownKeys: plugin.knownKeys() }).query;
    const query: ParsedQuery = { ...parsed, mode: "instant", lane: undefined, must: parsed.must.map((g) => g.filter((term) => term.kind !== "word" || !ASK_STOPWORDS.has(term.text.toLowerCase()))).filter((g) => g.length > 0) };
    const search = (q: ParsedQuery) => plugin.worker.call("search", [q, { limit: ASK_ANSWERS, fuzzy: plugin.settings.typoTolerance, weights: plugin.settings.fieldWeights, bodies: "all" }], signal);
    try {
      let reply = query.must.length > 0 || query.filters.length > 0 ? await search(query) : { title: [], body: [] };
      if (new Set([...reply.title, ...reply.body].map((h) => h.path)).size < 3 && query.must.length > 1) reply = await search({ ...query, must: [query.must.flat()] });
      if (signal.aborted) return;
      const rows = fuseLanes({ title: reply.title.map((h) => fromWorker(h, plugin.collection)), body: reply.body.map((h) => fromWorker(h, plugin.collection)), engine: [] }, (path) => plugin.local.daysSinceOpened(path), false);
      this.results = rows.slice(0, ASK_ANSWERS).map((row, i): Result => ({
        id: row.blockId ?? row.id,
        source: row.id,
        path: row.path,
        title: row.title,
        collection: row.collection,
        ...(row.blockId ? { block: { id: row.blockId, headings: row.headings, start: row.offset ?? 0, end: Number.MAX_SAFE_INTEGER } } : {}),
        snippet: row.snippet,
        highlights: row.highlights,
        scores: { fused: row.score, fusedRank: i + 1 },
        matchedBy: row.matchedBy,
        label: labelForRank(i + 1),
      }));
    } catch {
      if (signal.aborted) return;
      this.results = [];
    }
    this.keywordOnly = true;
    this.stage = "lex";
    this.final = true;
    this.host.changed();
  }

  /** "More like this": re-anchors the search on a block. */
  async moreLike(r: Result): Promise<void> {
    this.cancelPreview();
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.question = "";
    this.label = t("moreLikeLabel", { name: r.block?.headings.at(-1) ?? r.title });
    this.results = [];
    this.stage = "vec";
    this.final = false;
    this.note = undefined;
    this.retry = "idle";
    this.previewed = false;
    this.carried = false;
    this.ranMode = undefined;
    this.expansions = [];
    this.neighbours.clear();
    this.error = null;
    this.keywordOnly = false;
    this.host.changed();
    try {
      const res = await this.plugin.engine.related({ anchor: r.block ? { block: r.block.id } : { source: r.source }, granularity: "block", limit: ASK_ANSWERS, collections: this.plugin.engine.collections(), loose: true }, abort.signal);
      if (abort.signal.aborted) return;
      this.results = res.results;
    } catch (err) {
      // A newer search cancelled this one; its state is not this one's to finish.
      if (abort.signal.aborted) return;
      this.error = err instanceof EngineOffline ? "offline" : (err as Error).message;
    }
    this.final = true;
    this.host.changed();
  }

  /**
   * Runs the Deep pass again for a question whose rerank ran out of time, with a long time limit.
   * The shown results stay until the reranked order arrives; the earlier keyword and fused batches
   * of the new run are not shown again. It adds no history entry.
   */
  async rerankNow(): Promise<void> {
    if (!canRerankNow(this.question, this.note, this.retry) || !this.plugin.engine.ready) return;
    this.cancelPreview();
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.retry = "running";
    this.host.changed();
    let reranked = false;
    try {
      const query = parseQuery(this.question, { mode: "ask", knownKeys: this.plugin.knownKeys() }).query;
      const req: AskRequest = { query, mode: "deep", collections: this.plugin.engine.collections(), limit: ASK_ANSWERS, fuzzy: this.plugin.settings.typoTolerance > 0, deadlineMs: RERANK_RETRY_MS };
      for await (const batch of this.plugin.engine.ask(req, abort.signal)) {
        if (abort.signal.aborted) return;
        if (batch.stage !== "rerank") continue;
        reranked = true;
        this.note = undefined;
        this.retry = "idle";
        this.applyBatch(batch);
      }
    } catch {
      if (abort.signal.aborted) return;
    }
    if (abort.signal.aborted) return;
    if (!reranked) this.retry = "failed";
    this.host.changed();
  }

  private applyBatch(batch: ResultBatch): void {
    // A stage with no results (a lane that timed out) keeps the rows that are already shown.
    const list = this.host.listEl();
    const before = new Map<string, DOMRect>();
    const animate = batch.stage === "rerank" && !reducedMotion();
    if (animate) list.querySelectorAll<HTMLElement>("[data-id]").forEach((el) => before.set(el.dataset["id"]!, el.getBoundingClientRect()));
    if (this.carried) {
      // The first batch of a new question replaces the previous question's answers, even empty.
      this.carried = false;
      this.results = batch.results;
    } else if (batch.results.length > 0 || this.results.length === 0) this.results = batch.results;
    this.stage = batch.stage;
    this.final = batch.final;
    if (batch.note) this.note = batch.note;
    if (batch.mode) this.ranMode = batch.mode;
    if (batch.expansions) this.expansions = batch.expansions;
    this.host.changed();
    if (!animate) return;
    // Rows animate to their new place once, then settle.
    list.querySelectorAll<HTMLElement>("[data-id]").forEach((el) => {
      const old = before.get(el.dataset["id"]!);
      if (!old) return;
      const dy = old.top - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) return;
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], { duration: 220, easing: "ease-out" });
    });
  }

  // ---------- rendering ----------

  renderStatus(el: HTMLElement): void {
    const snapshot = this.plugin.engine.snapshot;
    const keywordNote = () => this.keywordOnly && el.createDiv({ cls: "trova-stale-note", text: t("askKeywordOnly") });
    if (snapshot.state === "disabled") {
      banner(el, t("needsEngine"));
      return void keywordNote();
    }
    if (!this.plugin.engine.ready || this.error === "offline") {
      banner(el, t("engineOffBanner"), { label: t("startEngine"), run: () => void this.plugin.engine.connect(true).then(() => void (this.question && this.run(this.question, { record: false, label: this.label }))) });
      return void keywordNote();
    }
    if (this.error) return void banner(el, `${t("internalError")}: ${this.error}`);
    const pct = this.plugin.indexedPercent();
    if (pct < 100) banner(el, t("indexPartial", { pct }));
    if (this.note === "model_missing") {
      banner(el, t("deepMissing"), {
        label: t("downloadModels"),
        run: () =>
          new ConfirmModal(this.plugin.app, t("downloadConfirmTitle"), t("downloadConfirmBody"), [], t("download"), () => {
            void this.plugin.engine.downloadModels().catch((e: Error) => new Notice(e.message));
          }).open(),
      });
    }
    if (this.note === "rerank_skipped") {
      // The answers shown are the fused ones; the user can ask for the reranked order.
      const box = el.createDiv({ cls: "trova-rerank-note", attr: { role: "status" } });
      const text = this.retry === "running" ? t("reranking") : this.retry === "failed" ? t("rerankFailed") : t("rerankSkippedLine");
      box.createSpan({ cls: "trova-rerank-text", text });
      if (this.retry === "running") box.createSpan({ cls: "trova-spinner is-busy", attr: { "aria-hidden": "true" } });
      else if (this.question && this.plugin.engine.ready) {
        box.createEl("button", { cls: "trova-small-button", text: this.retry === "failed" ? t("tryAgain") : t("rerankNow") }).addEventListener("click", () => void this.rerankNow());
      }
    }
    if (this.explain && this.expansions.length) {
      const box = el.createDiv({ cls: "trova-explain" });
      box.createDiv({ cls: "trova-why-title", text: t("explainSubqueries") });
      for (const e of this.expansions) box.createDiv({ text: `${e.type}: ${e.query}` });
    }
  }

  /**
   * The mode the shown answers come from, for the pane's "Answers" line: "Fast", "Deep", or
   * "Deep · refining…" while a run is still improving them. Empty before the engine says which.
   */
  modeText(): string {
    const name = this.ranMode === "deep" ? t("modeDeep") : this.ranMode === "fast" ? t("modeFast") : "";
    if (this.final) return name;
    return name ? `${name} · ${t("refining")}…` : `${t("refining")}…`;
  }

  /**
   * True when the shown answers came from the typing preview, which runs Fast, and pressing Enter
   * would run a Deep search. The pane then offers "↵ Deep".
   */
  offersDeep(): boolean {
    return this.previewed && this.final && this.plugin.engine.ready && !this.keywordOnly && deepOnEnter(this.question, this.mode);
  }

  /** Runs the shown question as Enter does: in the selected mode, saved to history. */
  runAgain(): void {
    if (this.question) void this.run(this.question, { label: this.label });
  }

  renderList(list: HTMLElement): void {
    if (this.results.length === 0) {
      if (this.final && this.active) list.createDiv({ cls: "trova-empty", text: t("noMatches") });
      return;
    }
    // A list needs a name for screen readers, but `aria-label` would also give it a hover tooltip.
    const box = list.createDiv({ cls: "trova-results", attr: { role: "list" } });
    quietLabel(box, t("answers"));
    for (const r of this.results) this.renderRow(box, r);
  }

  /**
   * An answer uses the same parts as a related note: a chevron, the title with its location, and
   * details on the title's left edge. Its snippet shows while collapsed, because the snippet is the
   * answer; the chevron shows the sections before and after it.
   */
  private renderRow(list: HTMLElement, r: Result): void {
    const group = list.createDiv({ cls: "trova-conn trova-answer", attr: { role: "listitem" } });
    group.dataset["id"] = r.id;
    const head = group.createDiv({ cls: "trova-conn-head", attr: { tabindex: "0", draggable: "true", "data-row": "", "data-key": r.id, "data-path": r.path } });
    if (r.path === this.host.selectedPath()) head.addClass("is-selected");
    const near = this.neighbours.get(r.id);
    const open = !!near;
    const expandable = !!r.block && !this.keywordOnly;
    const setOpen = (next: boolean) => {
      if (expandable && next !== open) void this.toggleNeighbours(r);
    };
    const toggle = head.createEl("button", { cls: "trova-conn-toggle", attr: { "aria-label": open ? t("hideNearby") : t("showNeighbours"), "aria-expanded": String(open), tabindex: "-1" } });
    setIcon(toggle, open ? "chevron-down" : "chevron-right");
    if (!expandable) toggle.addClass("is-hidden");
    else head.setAttribute("aria-expanded", String(open));
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      setOpen(!open);
    });
    head.createSpan({ cls: "trova-conn-title", text: r.title });
    // The section that matched says more than the folder; a whole-note match shows the folder.
    const where = r.block?.headings.length ? `› ${r.block.headings.join(" › ")}` : folderOf(r.path);
    if (where) head.createSpan({ cls: "trova-row-path", text: where });
    // The match lanes are detail; they show with the ranking details. The type badge always shows.
    if (r.type || this.explain) renderBadges(head.createSpan({ cls: "trova-badges" }), this.explain ? r.matchedBy : [], r.type);
    const actions = head.createSpan({ cls: "trova-row-actions" });
    const action = (icon: string, label: string, run: () => void) => {
      const b = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label, tabindex: "-1" } });
      setIcon(b, icon);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        run();
      });
    };
    action("shopping-basket", t("addToBasket"), () => this.plugin.addResultToBasket(r));
    if (!this.keywordOnly) action("sparkles", t("moreLikeThis"), () => void this.moreLike(r));

    const openAnswer = (where: OpenIn) => void this.plugin.openResult(r, where, this.question);
    const menu = (e: MouseEvent) =>
      showMenu(e, (m) => {
        m.addItem((i) => i.setTitle(t("open")).setIcon("file").onClick(() => openAnswer(false)));
        m.addItem((i) => i.setTitle(t("openNewTab")).setIcon("file-plus").onClick(() => openAnswer("tab")));
        m.addItem((i) => i.setTitle(t("insertLink")).setIcon("link").onClick(() => this.plugin.insertLink(r)));
        m.addItem((i) => i.setTitle(t("addToBasket")).setIcon("shopping-basket").onClick(() => this.plugin.addResultToBasket(r)));
        if (r.block) m.addItem((i) => i.setTitle(t("addBlockNeighbours")).setIcon("list-plus").onClick(() => this.plugin.addResultToBasket(r, true)));
        if (expandable) m.addItem((i) => i.setTitle(open ? t("hideNearby") : t("showNeighbours")).setIcon("chevrons-up-down").onClick(() => setOpen(!open)));
        m.addItem((i) => i.setTitle(t("moreLikeThis")).setIcon("sparkles").onClick(() => void this.moreLike(r)));
      });
    head.addEventListener("dragstart", (e) => e.dataTransfer?.setData("text/plain", this.plugin.linkText(r)));
    this.host.wireRow(head, { path: r.path, open: openAnswer, insertLink: () => this.plugin.insertLink(r), menu, expand: setOpen, toggle: () => setOpen(!open) });

    // The answer itself, on the title's edge. A click on it opens the answer like the title does.
    const body = group.createDiv({ cls: "trova-answer-body" });
    const heading = r.block?.headings.at(-1);
    renderHighlighted(body.createDiv({ cls: "trova-row-snippet" }), stripHeading(r.snippet, heading), shiftHighlights(r.snippet, r.highlights, heading));
    if (r.context) body.createDiv({ cls: "trova-row-context", text: r.context });
    onOpen(body, openAnswer);

    if (this.explain) {
      const ex = body.createDiv({ cls: "trova-explain" });
      const fmt = (v: number | undefined, digits = 3) => (v === undefined ? "–" : v.toFixed(digits));
      const cells: [string, string][] = [
        [t("explainLex"), fmt(r.scores.lex, 2)],
        [t("explainVec"), fmt(r.scores.vec)],
        [t("explainFused"), fmt(r.scores.fused, 4)],
        [t("explainRank"), r.scores.fusedRank === undefined ? "–" : String(r.scores.fusedRank)],
        [t("explainRerank"), fmt(r.scores.rerank)],
      ];
      for (const [k, v] of cells) ex.createSpan({ cls: "trova-explain-cell", text: `${k} ${v}` });
    }

    // Nearby sections use the related note's section style.
    if (!near?.neighbours) return;
    for (const n of [...near.neighbours.before, ...near.neighbours.after]) {
      const section = group.createDiv({ cls: "trova-conn-block", attr: { tabindex: "0", "data-row": "", "data-key": `${r.id}~${n.block?.start ?? 0}`, "data-path": r.path } });
      section.createDiv({ cls: "trova-row-heading", text: n.block?.headings.join(" › ") || r.title });
      section.createDiv({ cls: "trova-row-snippet", text: n.content.replace(/^#+\s.*\n/, "").trim().slice(0, 280) });
      const openSection = (where: OpenIn) => void this.plugin.open({ path: r.path, root: this.plugin.rootOf(r.collection ?? ""), headings: n.block?.headings, offset: n.block?.start }, where);
      this.host.wireRow(section, {
        path: r.path,
        open: openSection,
        insertLink: () => this.plugin.insertLink(r),
        menu,
        expand: (next) => !next && (head.focus(), setOpen(false)),
        toggle: () => (head.focus(), setOpen(false)),
      });
    }
  }

  private async toggleNeighbours(r: Result): Promise<void> {
    if (this.neighbours.has(r.id)) this.neighbours.delete(r.id);
    else {
      try {
        this.neighbours.set(r.id, await this.plugin.engine.get({ id: r.id, neighbours: 1 }));
      } catch {
        return;
      }
    }
    this.host.changed();
  }

  historyMenu(e: MouseEvent, run: (query: string, mode: AskMode) => void): void {
    const history = this.plugin.local.history();
    showMenu(e, (menu) => {
      if (history.length === 0) menu.addItem((i) => i.setTitle(t("noHistory")).setDisabled(true));
      for (const h of history.slice(0, 20)) menu.addItem((i) => i.setTitle(historyTitle(h.query)).onClick(() => run(h.query, h.mode)));
      if (history.length) {
        menu.addSeparator();
        menu.addItem((i) => i.setTitle(t("clear")).setIcon("trash").onClick(() => this.plugin.local.clearHistory()));
      }
    });
  }

  /** "Save as search": embeds the results in a note as an `trova` code block. */
  saveAsSearch(): void {
    if (!this.question) return;
    const block = `\`\`\`trova\n${this.question}\nmode: ask\nlimit: 10\n\`\`\`\n`;
    const leaf = this.plugin.app.workspace.getMostRecentLeaf(this.plugin.app.workspace.rootSplit);
    const editor = leaf?.view instanceof MarkdownView ? leaf.view.editor : null;
    if (editor) {
      editor.replaceSelection(block);
      new Notice(t("savedSearchInserted"));
    } else {
      void navigator.clipboard.writeText(block);
      new Notice(t("savedSearchCopied"));
    }
  }
}

/** A history entry's menu title: long passages are cut, and a passage query reads as one. */
export function historyTitle(query: string): string {
  const passage = /^vec:\s*/.test(query);
  const text = query.replace(/^vec:\s*/, "").replace(/\s+/g, " ");
  const cut = text.length > 70 ? `${text.slice(0, 69)}…` : text;
  return passage ? `≈ ${cut}` : cut;
}

/**
 * Snippets often start with the block's own heading, which the row already shows. This drops a
 * leading `# heading`: the given heading text when it matches, else the whole first line when the
 * snippet has more than one line. A snippet cut as "…heading text" loses the heading too. It never
 * returns an empty snippet.
 */
export function stripHeading(snippet: string, heading?: string): string {
  const cut = /^(?:…|\.\.\.)\s*/.exec(snippet);
  if (cut && heading) {
    const after = snippet.slice(cut[0].length);
    if (after.toLowerCase().startsWith(heading.toLowerCase())) return after.slice(heading.length).trimStart() || snippet;
  }
  const marker = /^#{1,6}\s+/.exec(snippet);
  if (!marker) return snippet;
  let rest: string | null = null;
  const after = snippet.slice(marker[0].length);
  if (heading && after.toLowerCase().startsWith(heading.toLowerCase())) rest = after.slice(heading.length);
  else if (after.includes("\n")) rest = after.slice(after.indexOf("\n"));
  const text = rest?.trimStart() ?? "";
  return text ? text : snippet;
}

/** Moves highlight ranges to match `stripHeading`, dropping ranges inside the removed heading. */
export function shiftHighlights(snippet: string, highlights: [number, number][], heading?: string): [number, number][] {
  const cut = snippet.length - stripHeading(snippet, heading).length;
  if (cut === 0) return highlights;
  return highlights.filter(([s]) => s >= cut).map(([s, e]) => [s - cut, e - cut]);
}
