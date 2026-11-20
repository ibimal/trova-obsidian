// The topic map: clusters of the vault drawn as a map, each labelled by its top terms. It draws
// on one canvas, so a vault of ten thousand notes pans and zooms without lag.

import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import type { TopicsResponse } from "@trova/contract";
import { t } from "../i18n/en.js";
import type TrovaPlugin from "../main.js";
import { banner, folderOf, navigableInMainArea, onOpen, openIn, passEnterKeys, type OpenIn } from "../ui.js";
import { GraphCanvas, type CanvasNode } from "./graphCanvas.js";

export const TOPIC_VIEW = "trova-topics";
const COLOURS = ["--color-blue", "--color-orange", "--color-green", "--color-purple", "--color-red", "--color-cyan", "--color-yellow", "--color-pink"];
const WIDTH = 1400;
const HEIGHT = 1000;

interface Dot {
  path: string;
  collection: string;
  cluster: number;
}

export class TopicMapView extends ItemView {
  private data: TopicsResponse | null = null;
  private timer: number | null = null;
  private canvas: GraphCanvas<Dot> | null = null;
  private barEl!: HTMLElement;
  private noticeEl!: HTMLElement;
  private stageEl!: HTMLElement;
  private legendEl!: HTMLElement;
  private infoEl!: HTMLElement;
  private byCluster = new Map<number, CanvasNode<Dot>[]>();
  private shownAt: number | undefined;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: TrovaPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return TOPIC_VIEW;
  }
  getDisplayText(): string {
    return t("topicTitle");
  }
  override getIcon(): string {
    return "map";
  }

  override async onOpen(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.addClass("trova-pane", "trova-graph");
    navigableInMainArea(this);
    passEnterKeys(this);
    this.barEl = el.createDiv({ cls: "trova-pane-header" });
    this.noticeEl = el.createDiv({ cls: "trova-notices" });
    this.stageEl = el.createDiv({ cls: "trova-graph-stage" });
    this.infoEl = el.createDiv({ cls: "trova-graph-info" });
    this.legendEl = el.createDiv({ cls: "trova-map-legend trova-map-legend-scroll" });
    this.canvas = new GraphCanvas<Dot>(this.stageEl, {
      simulate: false,
      ariaLabel: t("topicTitle"),
      onClick: (node, e) => {
        const where = openIn(e);
        if (where) return void this.openDot(node, where);
        this.canvas?.select(node.id);
        this.renderInfo(node);
      },
      onOpen: (node, e) => void this.openDot(node, openIn(e)),
      onBackgroundClick: () => {
        this.canvas?.select(null);
        this.renderInfo(null);
      },
    });
    this.registerEvent(this.app.workspace.on("css-change", () => this.canvas?.refreshTheme()));
    this.register(this.plugin.engine.onChange(() => (this.data ? this.renderBar() : void this.fetchTopics(false))));
    await this.fetchTopics(false);
  }

  override async onClose(): Promise<void> {
    if (this.timer) window.clearTimeout(this.timer);
    this.canvas?.destroy();
    this.canvas = null;
  }

  private openDot(node: CanvasNode<Dot>, where: OpenIn): Promise<void> {
    return this.plugin.open({ path: node.data.path, root: this.plugin.rootOf(node.data.collection) }, where);
  }

  private async fetchTopics(start: boolean): Promise<void> {
    if (this.timer) window.clearTimeout(this.timer);
    try {
      this.data = await this.plugin.engine.topics(start);
    } catch {
      this.data = null;
    }
    this.render();
    // The job runs in the background; poll until it is done.
    if (this.data?.state === "running") this.timer = window.setTimeout(() => void this.fetchTopics(false), 1500);
  }

  private renderBar(): void {
    const bar = this.barEl;
    bar.empty();
    const row = bar.createDiv({ cls: "trova-pane-toolbar" });
    const running = this.data?.state === "running";
    const progress = this.plugin.engine.snapshot.progress;
    const build = row.createEl("button", { text: running ? t("scanning", { done: progress?.done ?? "…", total: progress?.total ?? "…" }) : this.data?.computedAt ? t("topicRebuild") : t("topicBuild"), cls: this.data?.computedAt ? "" : "mod-cta" });
    build.disabled = running || !this.plugin.engine.ready;
    build.addEventListener("click", () => void this.fetchTopics(true));
    const fit = row.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("graphFit") } });
    setIcon(fit, "maximize");
    fit.addEventListener("click", () => this.canvas?.fit());
    if (this.data?.computedAt) row.createSpan({ cls: "trova-graph-count", text: new Date(this.data.computedAt).toLocaleString() });
  }

  private render(): void {
    this.renderBar();
    this.noticeEl.empty();
    const clusters = this.data?.clusters ?? [];
    if (!this.plugin.engine.ready && clusters.length === 0) banner(this.noticeEl, t("needsEngine"));
    else if (clusters.length === 0) this.noticeEl.createDiv({ cls: "trova-empty", text: t("topicEmpty") });
    // The same computed map is not laid out twice; polling while a job runs keeps the picture still.
    if (this.shownAt === this.data?.computedAt && this.byCluster.size > 0) return;
    this.shownAt = this.data?.computedAt;
    this.byCluster.clear();
    const nodes: CanvasNode<Dot>[] = [];
    const r = clusters.reduce((n, c) => n + c.sources.length, 0) > 3000 ? 3 : 5;
    clusters.forEach((c, i) => {
      const list: CanvasNode<Dot>[] = [];
      for (const s of c.sources) {
        list.push({ id: s.id, label: s.title, x: s.x * WIDTH, y: s.y * HEIGHT, r, color: COLOURS[i % COLOURS.length]!, data: { path: s.path, collection: s.id.slice(0, s.id.indexOf(":")), cluster: c.id } });
      }
      this.byCluster.set(c.id, list);
      nodes.push(...list);
    });
    this.canvas?.setData(nodes, [], clusters.map((c) => ({ x: c.x * WIDTH, y: c.y * HEIGHT, text: c.label.slice(0, 3).join(" · ") })));
    this.renderInfo(null);
    const legend = this.legendEl;
    legend.empty();
    clusters.forEach((c, i) => {
      // A legend entry zooms the map to its cluster.
      const item = legend.createEl("button", { cls: "trova-map-legend-item trova-map-legend-button" });
      item.createSpan({ cls: "trova-map-swatch" }).style.backgroundColor = `var(${COLOURS[i % COLOURS.length]})`;
      item.appendText(`${c.label.join(" · ")} (${t("topicNotes", { n: c.sources.length })})`);
      item.addEventListener("click", () => this.canvas?.fit(this.byCluster.get(c.id)));
    });
  }

  private renderInfo(node: CanvasNode<Dot> | null): void {
    const el = this.infoEl;
    el.empty();
    if (!node) {
      if (this.byCluster.size > 0) el.createDiv({ cls: "trova-graph-hint", text: t("topicHint") });
      return;
    }
    // One row in the bar under the map: the note and its folder, then the two actions.
    const card = el.createDiv({ cls: "trova-graph-card" });
    const head = card.createDiv({ cls: "trova-graph-card-main" }).createDiv({ cls: "trova-row-head" });
    head.createSpan({ cls: "trova-row-title", text: node.label });
    const folder = folderOf(node.data.path);
    if (folder) head.createSpan({ cls: "trova-row-path", text: folder });
    const actions = card.createDiv({ cls: "trova-card-actions" });
    onOpen(actions.createEl("button", { text: t("open"), cls: "mod-cta" }), (where) => void this.openDot(node, where));
    if (node.data.collection === this.plugin.collection) actions.createEl("button", { text: t("graphOpenHere") }).addEventListener("click", () => void this.plugin.openGraph(node.data.path));
  }
}
