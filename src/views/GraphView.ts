// The similarity graph in an editor tab: the full-size version of the Connections pane's graph
// drawer, with a toolbar and a card for the selected note.

import { ItemView, MarkdownView, TFile, debounce, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { t } from "../i18n/en.js";
import type TrovaPlugin from "../main.js";
import { navigableInMainArea, passEnterKeys, quietLabel } from "../ui.js";
import { SimilarityGraph } from "./similarityGraph.js";

export const GRAPH_VIEW = "trova-graph";

/** The node counts the size menu offers. */
export const GRAPH_SIZES = [12, 24, 40, 60];

export class GraphView extends ItemView {
  private graph: SimilarityGraph | null = null;
  private locked = false;
  private toolbarEl!: HTMLElement;
  private countEl: HTMLElement | null = null;
  private spinnerEl: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: TrovaPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return GRAPH_VIEW;
  }
  getDisplayText(): string {
    return t("graphTitle");
  }
  override getIcon(): string {
    return "git-fork";
  }

  override async onOpen(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.addClass("trova-pane", "trova-graph");
    navigableInMainArea(this);
    passEnterKeys(this);
    this.toolbarEl = el.createDiv({ cls: "trova-pane-header" });
    const graph = (this.graph = new SimilarityGraph(el, this.plugin, {
      compact: false,
      limit: 24,
      loose: this.plugin.settings.showLoose,
      onChange: () => this.renderStatus(),
    }));
    graph.onCentre = (path) => {
      // Centring on a note locks the graph there, so opening other notes does not move it.
      this.locked = true;
      this.renderToolbar();
      void graph.load(path, true);
    };
    const follow = debounce(() => this.followActive(), 300, true);
    this.registerEvent(this.app.workspace.on("file-open", follow));
    this.registerEvent(this.app.workspace.on("active-leaf-change", follow));
    this.registerEvent(this.app.workspace.on("css-change", () => this.graph?.refreshTheme()));
    let ready = this.plugin.engine.ready;
    this.register(
      this.plugin.engine.onChange(() => {
        if (this.plugin.engine.ready === ready) return;
        ready = this.plugin.engine.ready;
        void this.graph?.load(this.graph.rootPath, true);
      }),
    );
    this.register(
      this.plugin.engine.onEvent((e) => {
        if (e.event === "index.ready") this.graph?.clearCache();
      }),
    );
    this.renderToolbar();
  }

  // The centre note, lock and size are kept in the tab's history and layout, so Back and a restart
  // bring the graph back as it was. Obsidian calls setState each time it opens the view, so the
  // first graph is drawn here.
  override getState(): Record<string, unknown> {
    return { ...super.getState(), path: this.graph?.rootPath ?? null, locked: this.locked, limit: this.graph?.limit };
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    const graph = this.graph;
    if (!graph) return;
    const s = (state ?? {}) as Record<string, unknown>;
    if (GRAPH_SIZES.includes(s["limit"] as number)) graph.limit = s["limit"] as number;
    if (typeof s["locked"] === "boolean") this.locked = s["locked"];
    this.renderToolbar();
    const path = s["path"];
    if (typeof path === "string" && this.app.vault.getAbstractFileByPath(path) instanceof TFile) void graph.load(path, true);
    else this.followActive(true);
  }

  override async onClose(): Promise<void> {
    this.graph?.destroy();
    this.graph = null;
  }

  /** The note in the active tab, or in the most recent tab of the editor area; null for none. */
  private activePath(): string | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file) return view.file.path;
    const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
    if (leaf === this.leaf) return null;
    const file = (leaf?.view as { file?: TFile } | undefined)?.file;
    return file instanceof TFile ? file.path : null;
  }

  /**
   * Follows the note being worked on. A tab that shows no note, such as this graph itself while it
   * has focus, is not a new note: the graph keeps what it shows. Only a graph with nothing shown
   * yet says to open a note.
   */
  private followActive(force = false): void {
    if (!this.graph || (this.locked && !force)) return;
    const path = this.activePath();
    if (path === null && this.graph.rootPath !== null) return;
    if (path === this.graph.rootPath && !force) return;
    void this.graph.load(path, force);
  }

  private renderStatus(): void {
    this.spinnerEl?.toggleClass("is-busy", !!this.graph?.busy);
    this.countEl?.setText(this.graph?.countText() ?? "");
  }

  private renderToolbar(): void {
    const graph = this.graph;
    if (!graph) return;
    const el = this.toolbarEl;
    el.empty();
    const row = el.createDiv({ cls: "trova-pane-toolbar" });
    const button = (icon: string, label: string, run: () => void, active = false) => {
      const b = row.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label, "aria-pressed": String(active) } });
      setIcon(b, icon);
      if (active) b.addClass("is-active");
      b.addEventListener("click", run);
      return b;
    };
    button(this.locked ? "lock" : "unlock", this.locked ? t("graphUnlock") : t("graphLock"), () => {
      this.locked = !this.locked;
      this.renderToolbar();
      if (!this.locked) this.followActive();
    }, this.locked);
    const select = row.createEl("select", { cls: "dropdown" });
    quietLabel(select, t("graphSize"));
    for (const n of GRAPH_SIZES) select.createEl("option", { text: t("graphNotes", { n }), value: String(n) });
    select.value = String(graph.limit);
    select.addEventListener("change", () => {
      graph.limit = Number(select.value);
      void graph.load(graph.rootPath, true);
    });
    button("circle-dashed", t("showLoose"), () => {
      graph.loose = !graph.loose;
      this.renderToolbar();
      void graph.load(graph.rootPath, true);
    }, graph.loose);
    button("maximize", t("graphFit"), () => graph.fit());
    button("refresh-cw", t("refresh"), () => {
      graph.clearCache();
      void graph.load(this.locked ? graph.rootPath : this.activePath(), true);
    });
    this.spinnerEl = row.createSpan({ cls: "trova-spinner" });
    this.countEl = row.createSpan({ cls: "trova-graph-count" });
    this.renderStatus();
  }
}
