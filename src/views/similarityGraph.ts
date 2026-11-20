// The similarity graph as a component: the anchor note in the middle, its related notes around it,
// and edges between related notes that are similar to each other. Clicking a node selects it;
// expanding a node adds that note's own related notes, so the user can walk the vault by meaning.
// The editor's Similarity graph view and the Connections pane's graph drawer both use it.

import { Notice, setIcon } from "obsidian";
import { DEFAULT_THRESHOLDS, EngineError, type GraphNode, type GraphResponse, type Label } from "@trova/contract";
import { t } from "../i18n/en.js";
import type TrovaPlugin from "../main.js";
import { Lru } from "../state/store.js";
import { banner, folderOf, labelText, linkFor, onOpen, openIn, showMenu, type OpenIn } from "../ui.js";
import { GraphCanvas, type CanvasEdge, type CanvasNode } from "./graphCanvas.js";

const MAX_NODES = 400;
/**
 * The bar under the graph narrower than this hides the folder and shows Expand and Centre as icons.
 * Only then do those two buttons get a tooltip; with their text showing, they need none.
 */
const NARROW_BAR = 560;
/** About 137.5°: successive angles never line up, so any few consecutive nodes spread out. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * How far up and down a column of labels reaches, as the tangent of its steepest direction: 0.8
 * is about 39° above or below level, and 0.95 about 44°. A column of more than 3 labels uses the
 * wider spread so its rows keep their distance. Below 45° a label sits beside its node, never
 * above or below it, so a column's labels stack without overlapping sideways.
 */
const LABEL_COLUMN_SPREAD = 0.8;
const LABEL_COLUMN_SPREAD_WIDE = 0.95;

/** The spread of a column with `count` labels. */
export function columnSpread(count: number): number {
  return count > 3 ? LABEL_COLUMN_SPREAD_WIDE : LABEL_COLUMN_SPREAD;
}

/**
 * The starting directions, in radians in screen space (0 is right, y grows downward), of `n`
 * labelled nodes around the anchor. They alternate between the right and the left side, strongest
 * first, and are spread evenly from top to bottom on each side, within 45° of level, where a label
 * sits beside its node and grows away from the anchor. The layout moves the nodes from there, so
 * this is where labels start, not where they must stay. The result depends only on `n`.
 */
export function labelAngles(n: number): number[] {
  if (n <= 0) return [];
  const counts = [Math.ceil(n / 2), Math.floor(n / 2)];
  const column = (count: number, dir: 1 | -1) =>
    Array.from({ length: count }, (_, i) => {
      const spread = columnSpread(count);
      const y = count === 1 ? 0 : -spread + (2 * spread * i) / (count - 1);
      return Math.atan2(y, dir);
    });
  const right = column(counts[0]!, 1);
  const left = column(counts[1]!, -1);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i % 2 === 0 ? right[i / 2]! : left[(i - 1) / 2]!);
  return out;
}

interface NodeData {
  node: GraphNode;
  /** The best similarity seen for this node, to whichever node it was found from. */
  score: number;
  anchor: boolean;
  expanded: boolean;
}

/** Merges graph responses into one node and edge set. Kept free of the DOM so tests can drive it. */
export class GraphModel {
  nodes = new Map<string, NodeData>();
  edges = new Map<string, { a: string; b: string; similarity: number; linked: boolean }>();

  clear(): void {
    this.nodes.clear();
    this.edges.clear();
  }

  /** Adds a response. Returns the ids of the nodes that are new. */
  merge(res: GraphResponse, isRoot: boolean): string[] {
    const added: string[] = [];
    const put = (node: GraphNode, anchor: boolean) => {
      const prev = this.nodes.get(node.id);
      if (prev) {
        // The anchor of an expansion keeps the score it had as a neighbour.
        if (!anchor) prev.score = Math.max(prev.score, node.score);
        if (anchor) prev.expanded = true;
        if (node.snippet && !prev.node.snippet) prev.node = { ...prev.node, snippet: node.snippet };
        return;
      }
      if (this.nodes.size >= MAX_NODES) return;
      this.nodes.set(node.id, { node, score: anchor ? 1 : node.score, anchor: anchor && isRoot, expanded: anchor });
      added.push(node.id);
    };
    if (res.anchor) put(res.anchor, true);
    for (const n of res.nodes) put(n, false);
    for (const e of res.edges) {
      if (!this.nodes.has(e.a) || !this.nodes.has(e.b)) continue;
      const key = e.a < e.b ? `${e.a}\n${e.b}` : `${e.b}\n${e.a}`;
      const prev = this.edges.get(key);
      if (!prev || prev.similarity < e.similarity) this.edges.set(key, { ...e });
    }
    return added;
  }
}

/**
 * Maps a cosine similarity to 0..1 for drawing. Similarities cluster between the Loose threshold
 * and about 0.9, so the raw value would draw almost every edge and node at the same weight.
 */
export function drawWeight(similarity: number, floor = DEFAULT_THRESHOLDS.loose): number {
  return Math.max(0, Math.min(1, (similarity - floor) / (1 - floor)));
}

/** How strongly a node is filled: strong notes are solid, loose ones faint but still visible. */
export function nodeAlpha(label: Label): number {
  return label === "strong" ? 0.95 : label === "related" ? 0.6 : 0.32;
}

export interface SimilarityGraphOptions {
  /** A compact graph has no bar under it; the host shows the selection itself. */
  compact: boolean;
  limit: number;
  loose: boolean;
  /** Called when the selection changes, with the selected note's path. */
  onSelect?(path: string | null): void;
  /** Called after the graph loads or grows, so a host can update a count or a spinner. */
  onChange?(): void;
}

export class SimilarityGraph {
  readonly model = new GraphModel();
  readonly el: HTMLElement;
  private canvas: GraphCanvas<NodeData>;
  private canvasNodes = new Map<string, CanvasNode<NodeData>>();
  private noticeEl: HTMLElement;
  private stageEl: HTMLElement;
  private infoEl: HTMLElement;
  private infoObserver: ResizeObserver | null = null;
  private abort: AbortController | null = null;
  private cache = new Lru<string, GraphResponse>(60);
  rootPath: string | null = null;
  /** The label count the current layout was made with. */
  private labelCount = -1;
  /**
   * The anchor's own related notes and their similarity to it, from the first response. Labels
   * are chosen from these only, so expanding a node never changes which notes are labelled.
   */
  private rootScores = new Map<string, number>();
  selectedId: string | null = null;
  busy = false;
  limit: number;
  loose: boolean;

  constructor(
    parent: HTMLElement,
    private plugin: TrovaPlugin,
    private opts: SimilarityGraphOptions,
  ) {
    this.limit = opts.limit;
    this.loose = opts.loose;
    this.el = parent.createDiv({ cls: "trova-similarity-graph" });
    this.noticeEl = this.el.createDiv({ cls: "trova-notices" });
    this.stageEl = this.el.createDiv({ cls: "trova-graph-stage" });
    this.infoEl = this.el.createDiv({ cls: "trova-graph-info" });
    if (!opts.compact) {
      this.infoObserver = new ResizeObserver(() => this.syncNarrow());
      this.infoObserver.observe(this.infoEl);
    }
    this.canvas = new GraphCanvas<NodeData>(this.stageEl, {
      simulate: true,
      ariaLabel: t("graphTitle"),
      onClick: (node, e) => (e.shiftKey ? void this.expand(node.id) : this.select(node.id)),
      onOpen: (node, e) => void this.openNode(node.data.node, openIn(e)),
      onContextMenu: (node, e) => this.nodeMenu(node.data, e),
      onBackgroundClick: () => this.select(null),
      // Node size already shows similarity, so edges keep one width. The compact drawer labels
      // only what the user points at, plus the few strongest notes.
      uniformEdges: true,
      labels: opts.compact ? "focus" : "auto",
    });
  }

  destroy(): void {
    this.abort?.abort();
    this.infoObserver?.disconnect();
    this.canvas.destroy();
  }

  refreshTheme(): void {
    this.canvas.refreshTheme();
  }

  fit(): void {
    this.canvas.fit();
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** The number of notes and links shown, or an empty string for an empty graph. */
  countText(): string {
    if (!this.model.nodes.size) return "";
    // The drawer's size menu already says how many notes it asked for; the count matters only
    // when the engine found fewer.
    if (this.opts.compact) {
      const found = this.model.nodes.size - 1;
      return found < this.limit ? t("graphFoundOnly", { n: found }) : "";
    }
    return t("graphCount", { nodes: this.model.nodes.size, edges: this.model.edges.size });
  }

  // ---------- data ----------

  private async fetch(source: string, signal: AbortSignal): Promise<GraphResponse> {
    const key = `${source}|${this.limit}|${this.loose ? 1 : 0}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const res = await this.plugin.engine.graph({ anchor: { source }, limit: this.limit, loose: this.loose, collections: this.plugin.engine.collections() }, signal);
    if (res.anchorIndexed) this.cache.set(key, res);
    return res;
  }

  /** Shows the graph around a note. Without `force`, the same note is not loaded twice. */
  async load(path: string | null, force: boolean): Promise<void> {
    if (path === this.rootPath && !force && this.model.nodes.size > 0) return;
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    if (path !== this.rootPath || force) {
      this.model.clear();
      this.canvasNodes.clear();
      this.rootScores.clear();
      this.selectedId = null;
    }
    this.rootPath = path;
    this.noticeEl.empty();
    const message = (text: string) => {
      this.sync([]);
      this.noticeEl.createDiv({ cls: "trova-empty", text });
      this.renderInfo();
    };
    if (!path) return message(t("noActiveNote"));
    if (this.plugin.indexer.isExcluded(path)) return message(t("noteExcluded"));
    if (!this.plugin.engine.ready) {
      this.sync([]);
      this.renderInfo();
      if (this.plugin.engine.snapshot.state === "disabled") banner(this.noticeEl, t("needsEngine"));
      else banner(this.noticeEl, t("engineOffBanner"), { label: t("startEngine"), run: () => void this.plugin.engine.connect(true) });
      return;
    }
    this.setBusy(true);
    try {
      const res = await this.fetch(this.plugin.sourceId(path), abort.signal);
      if (abort.signal.aborted) return;
      if (!res.anchorIndexed) return message(t("notIndexedYet"));
      const added = this.model.merge(res, true);
      this.rootScores = new Map(res.nodes.map((n) => [n.id, n.score]));
      this.sync(added, res.anchor?.id, true);
      if (res.nodes.length === 0) this.noticeEl.createDiv({ cls: "trova-empty", text: t("noConnections") });
    } catch (err) {
      if (abort.signal.aborted) return;
      message(err instanceof EngineError && err.code === "not_found" ? t("notIndexedYet") : t("engineOffBanner"));
    } finally {
      if (!abort.signal.aborted) this.setBusy(false);
    }
    this.renderInfo();
  }

  /** Adds a node's own related notes to the graph. */
  async expand(id: string): Promise<void> {
    const data = this.model.nodes.get(id);
    if (!data || !this.plugin.engine.ready) return;
    if (this.model.nodes.size >= MAX_NODES) return void new Notice(t("graphFull", { n: MAX_NODES }));
    const abort = (this.abort ??= new AbortController());
    this.setBusy(true);
    try {
      const res = await this.fetch(id, abort.signal);
      if (abort.signal.aborted) return;
      const added = this.model.merge(res, false);
      data.expanded = true;
      this.sync(added, id);
      if (added.length === 0) new Notice(t("graphNothingNew"));
    } catch {
      /* the banner already reports an engine that went away */
    } finally {
      this.setBusy(false);
    }
    this.renderInfo();
  }

  /** Pushes the model to the canvas. New nodes start next to the node they were found from. */
  private sync(added: string[], near?: string, refit = false): void {
    const origin = near ? this.canvasNodes.get(near) : undefined;
    for (const id of [...this.canvasNodes.keys()]) if (!this.model.nodes.has(id)) this.canvasNodes.delete(id);
    // New nodes start on a golden-angle spiral, in order of similarity: any run of consecutive
    // notes, such as the few strongest that carry labels, starts spread around the anchor
    // instead of bunched in one sector.
    const order = new Map(
      added
        .filter((id) => !this.model.nodes.get(id)?.anchor)
        .sort((a, b) => (this.model.nodes.get(b)?.score ?? 0) - (this.model.nodes.get(a)?.score ?? 0))
        .map((id, rank) => [id, rank]),
    );
    // The drawer labels the strongest of the anchor's own related notes, ranked by similarity to
    // the anchor. Each starts on a direction from `labelAngles`, alternating left and right, so the
    // labels begin spread out; the layout then moves them freely, so every link length still shows
    // similarity. The canvas places each label on a free side or leaves it out. Notes added by
    // expanding another node are not candidates: they belong around the node they came from.
    const anchorId = [...this.model.nodes.entries()].find(([, d]) => d.anchor)?.[0] ?? null;
    const ranked = [...this.rootScores.entries()]
      .filter(([id]) => this.model.nodes.has(id) && id !== anchorId)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, this.opts.compact ? Math.max(0, this.plugin.settings.graphLabels) : 0)
      .map(([id]) => id);
    this.labelCount = this.plugin.settings.graphLabels;
    const angles = labelAngles(ranked.length);
    const slot = new Map(ranked.map((id, i) => [id, angles[i]!]));
    for (const [id, data] of this.model.nodes) {
      let node = this.canvasNodes.get(id);
      if (!node) {
        const angle = slot.get(id) ?? -Math.PI / 2 + (order.get(id) ?? 0) * GOLDEN_ANGLE;
        const distance = data.anchor ? 0 : 120 + (1 - data.score) * 160;
        node = { id, label: data.node.title, x: (origin?.x ?? 0) + Math.cos(angle) * distance, y: (origin?.y ?? 0) + Math.sin(angle) * distance, r: 6, color: "", data };
        this.canvasNodes.set(id, node);
      }
      node.data = data;
      // One accent colour; size and fill strength show similarity, so the graph also reads in grey.
      node.r = data.anchor ? 11 : 4 + 8 * drawWeight(data.score);
      // The anchor is a ring around the page colour, so it stands out without a colour of its own.
      node.color = data.anchor ? "--background-primary" : "--interactive-accent";
      node.alpha = data.anchor ? 1 : nodeAlpha(data.node.label);
      node.ring = data.anchor;
      node.fixed = data.anchor;
      // The drawer does not name its centre: the pane above already says which note it is, and a
      // label under the centre would crowd the labels around it. The editor graph names it.
      node.showLabel = (data.anchor && !this.opts.compact) || slot.has(id);
    }
    const edges: CanvasEdge<NodeData>[] = [];
    for (const e of this.model.edges.values()) {
      const a = this.canvasNodes.get(e.a);
      const b = this.canvasNodes.get(e.b);
      // In the drawer, links between two related notes appear only when one of them is pointed at;
      // the spokes from this note are always drawn.
      const spoke = a?.data.anchor || b?.data.anchor;
      if (a && b) edges.push({ a, b, weight: drawWeight(e.similarity), strong: e.linked, quiet: this.opts.compact && !spoke && !e.linked });
    }
    this.canvas.setData([...this.canvasNodes.values()], edges, [], { refit, centreId: anchorId });
    this.canvas.select(this.selectedId);
    if (added.length > 0 && near && this.model.nodes.size > added.length + 1) this.canvas.reheat(0.6);
    this.opts.onChange?.();
  }

  /** Redraws after a setting such as the label count changed. */
  relabel(): void {
    // The pane calls this on every change to the stored data; only a new label count matters.
    // Then the labelled notes and their directions change, so the view fits the new layout.
    if (this.plugin.settings.graphLabels === this.labelCount || !this.model.nodes.size) return;
    this.sync([], undefined, true);
  }

  private setBusy(on: boolean): void {
    this.busy = on;
    this.opts.onChange?.();
  }

  // ---------- selection ----------

  /** Selects a node by id. The host hears about it through `onSelect`. */
  select(id: string | null): void {
    this.selectedId = id;
    this.canvas.select(id);
    this.renderInfo();
    this.opts.onSelect?.(id ? (this.model.nodes.get(id)?.node.path ?? null) : null);
  }

  /** Selects the node of a note, when the graph shows it. Does not call `onSelect`. */
  selectPath(path: string | null): void {
    let id: string | null = null;
    if (path) for (const [key, data] of this.model.nodes) if (data.node.path === path && !data.anchor) id = key;
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.canvas.select(id);
    this.renderInfo();
  }

  /** Lights a node, such as the one under a hovered row, without selecting it. */
  highlightPath(path: string | null): void {
    let id: string | null = null;
    if (path) for (const [key, data] of this.model.nodes) if (data.node.path === path) id = key;
    this.canvas.highlight(id);
  }

  /**
   * The bar under the editor graph: the selected note, why it is here, and what to do with it. It
   * keeps one height with or without a selection, so selecting a node never moves the map.
   */
  private renderInfo(): void {
    const el = this.infoEl;
    el.empty();
    if (this.opts.compact) return;
    const data = this.selectedId ? this.model.nodes.get(this.selectedId) : undefined;
    if (!data) {
      if (this.model.nodes.size > 1) el.createDiv({ cls: "trova-graph-hint", text: t("graphHint") });
      return;
    }
    const { node } = data;
    const card = el.createDiv({ cls: "trova-graph-card" });
    const main = card.createDiv({ cls: "trova-graph-card-main" });
    const head = main.createDiv({ cls: "trova-row-head" });
    head.createSpan({ cls: "trova-row-title", text: node.title });
    const folder = folderOf(node.path);
    if (folder) head.createSpan({ cls: "trova-row-path", text: folder });
    if (!data.anchor) head.createSpan({ cls: `trova-label trova-label-${node.label}`, text: `${labelText(node.label)} · ${Math.round(data.score * 100)}%` });
    if (node.snippet) main.createDiv({ cls: "trova-row-snippet", text: node.snippet });
    const actions = card.createDiv({ cls: "trova-card-actions" });
    onOpen(actions.createEl("button", { text: t("open"), cls: "mod-cta" }), (where) => void this.openNode(node, where));
    // In a narrow bar these two show only their icon; `syncNarrow` then gives them their label as
    // name and tooltip.
    const action = (icon: string, label: string, run: () => void) => {
      const button = actions.createEl("button", { cls: "trova-graph-action", attr: { "data-label": label } });
      setIcon(button.createSpan({ cls: "trova-graph-action-icon", attr: { "aria-hidden": "true" } }), icon);
      button.createSpan({ cls: "trova-graph-action-text", text: label });
      button.addEventListener("click", run);
    };
    if (!data.expanded) action("git-fork", t("graphExpand"), () => void this.expand(node.id));
    if (!data.anchor && node.collection === this.plugin.collection) action("locate-fixed", t("graphCentreButton"), () => this.centre(node.path));
    this.syncNarrow();
  }

  /** Switches the bar to its narrow form, and gives the icon-only buttons their tooltip. */
  private syncNarrow(): void {
    const narrow = this.infoEl.clientWidth > 0 && this.infoEl.clientWidth <= NARROW_BAR;
    this.infoEl.toggleClass("is-narrow", narrow);
    for (const button of this.infoEl.querySelectorAll<HTMLElement>(".trova-graph-action")) {
      if (narrow) button.setAttribute("aria-label", button.dataset["label"] ?? "");
      else button.removeAttribute("aria-label");
    }
  }

  /** Called when the user centres the graph on a node; the editor view also locks it there. */
  onCentre: (path: string) => void = (path) => void this.load(path, true);

  private centre(path: string): void {
    this.onCentre(path);
  }

  private async openNode(node: GraphNode, where: OpenIn): Promise<void> {
    await this.plugin.open({ path: node.path, root: this.plugin.rootOf(node.collection) }, where);
  }

  private nodeMenu(data: NodeData, e: MouseEvent): void {
    const { node } = data;
    const inVault = node.collection === this.plugin.collection;
    showMenu(e, (menu) => {
      menu.addItem((i) => i.setTitle(t("open")).setIcon("file").onClick(() => void this.openNode(node, false)));
      menu.addItem((i) => i.setTitle(t("openNewTab")).setIcon("file-plus").onClick(() => void this.openNode(node, "tab")));
      menu.addSeparator();
      if (!data.expanded) menu.addItem((i) => i.setTitle(t("graphExpand")).setIcon("git-fork").onClick(() => void this.expand(node.id)));
      if (inVault && !data.anchor) menu.addItem((i) => i.setTitle(t("graphCenter")).setIcon("locate-fixed").onClick(() => this.centre(node.path)));
      if (inVault) {
        menu.addItem((i) => i.setTitle(t("addToBasket")).setIcon("shopping-basket").onClick(() => new Notice(this.plugin.basket.add(node.path) ? t("addedToBasket") : t("alreadyInBasket"))));
        menu.addItem((i) => i.setTitle(t("copyLink")).setIcon("link").onClick(() => {
          void navigator.clipboard.writeText(linkFor(this.plugin.app, node.path, undefined, this.rootPath ?? ""));
          new Notice(t("copied"));
        }));
      }
    });
  }
}
