// GraphCanvas: one <canvas> that draws nodes and edges with pan, zoom, drag and hover. The
// similarity graph runs a small force layout on it; the topic map gives every node a fixed place.
// It draws only when something changed, so an idle graph costs no CPU.

import { quietLabel, reducedMotion } from "../ui.js";

export interface CanvasNode<T = unknown> {
  id: string;
  label: string;
  x: number;
  y: number;
  /** Radius in world units. */
  r: number;
  /** A CSS colour or a CSS variable name such as `--color-blue`. */
  color: string;
  /** Draws a ring around the node; used for the anchor and the selected node. */
  ring?: boolean;
  /** Always draws the label, whatever the zoom. */
  showLabel?: boolean;
  /** Fill opacity, 0..1; 0.95 when not set. Lets one colour show several strengths. */
  alpha?: number;
  /** The layout never moves this node; the anchor of the similarity graph stays at its origin. */
  fixed?: boolean;
  data: T;
  vx?: number;
  vy?: number;
}

export interface CanvasEdge<T = unknown> {
  a: CanvasNode<T>;
  b: CanvasNode<T>;
  /** 0..1; a heavier edge pulls its ends closer, and is drawn wider unless `uniformEdges` is on. */
  weight: number;
  /** Drawn in the accent colour, for notes that already link to each other. */
  strong?: boolean;
  /** Drawn only while one of its ends is hovered, focused or selected. */
  quiet?: boolean;
}

export interface CanvasAnnotation {
  x: number;
  y: number;
  text: string;
}

export interface CanvasOptions<T> {
  /** Runs the force layout. Off for data that carries its own positions. */
  simulate: boolean;
  ariaLabel: string;
  onClick?(node: CanvasNode<T>, e: MouseEvent): void;
  /** Opens a node: on double-click, middle-click, or Enter on the selected node. */
  onOpen?(node: CanvasNode<T>, e: MouseEvent | KeyboardEvent): void;
  onContextMenu?(node: CanvasNode<T>, e: MouseEvent): void;
  onBackgroundClick?(): void;
  /**
   * "auto" labels every node in a small graph; "focus" labels only nodes marked `showLabel`, the
   * selected node, and the focused node with its neighbours. Defaults to "auto".
   */
  labels?: "auto" | "focus";
  /** Draws every edge at one width; opacity still follows the weight. Defaults to false. */
  uniformEdges?: boolean;
}

const REPULSION = 2600;
const DAMPING = 0.8;
const ALPHA_DECAY = 0.982;
const ALPHA_MIN = 0.012;
const MAX_LABELS = 140;
/** Labels need this much clear space around them, in screen pixels. */
const LABEL_MARGIN = 3;

export class GraphCanvas<T = unknown> {
  readonly el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private nodes: CanvasNode<T>[] = [];
  private edges: CanvasEdge<T>[] = [];
  private annotations: CanvasAnnotation[] = [];
  private neighbours = new Map<string, Set<string>>();
  private k = 1;
  private tx = 0;
  private ty = 0;
  private width = 0;
  private height = 0;
  private alpha = 0;
  private frame = 0;
  private hovered: CanvasNode<T> | null = null;
  /** A node lit from outside the canvas, such as the one under a hovered list row. */
  private highlighted: CanvasNode<T> | null = null;
  private selectedId: string | null = null;
  private drag: { node: CanvasNode<T> | null; x: number; y: number; moved: boolean; id: number } | null = null;
  private colors = new Map<string, string>();
  private observer: ResizeObserver;
  private fitted = false;
  /** The node `fit` keeps in the middle of the canvas, or null to fit the bounding box. */
  private centreId: string | null = null;
  /** While true, the view keeps fitting the graph as the layout settles. */
  private following = false;

  constructor(
    private parent: HTMLElement,
    private opts: CanvasOptions<T>,
  ) {
    this.el = parent.createEl("canvas", { cls: "trova-graph-canvas", attr: { tabindex: "0", role: "application" } });
    quietLabel(this.el, opts.ariaLabel);
    this.ctx = this.el.getContext("2d")!;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(parent);
    this.el.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.el.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.el.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.el.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.el.addEventListener("pointercancel", () => (this.drag = null));
    this.el.addEventListener("pointerleave", () => this.setHovered(null));
    this.el.addEventListener("dblclick", (e) => {
      const node = this.nodeAt(e.offsetX, e.offsetY);
      if (node) this.opts.onOpen?.(node, e);
    });
    this.el.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault());
    this.el.addEventListener("auxclick", (e) => {
      const node = e.button === 1 ? this.nodeAt(e.offsetX, e.offsetY) : null;
      if (!node) return;
      e.preventDefault();
      this.opts.onOpen?.(node, e);
    });
    this.el.addEventListener("contextmenu", (e) => {
      const node = this.nodeAt(e.offsetX, e.offsetY);
      if (!node) return;
      e.preventDefault();
      this.opts.onContextMenu?.(node, e);
    });
    this.el.addEventListener("keydown", (e) => this.onKey(e));
    this.resize();
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.el.remove();
  }

  // ---------- data ----------

  /**
   * Replaces the data. A node object that was already shown keeps its position, so merging new
   * nodes into the graph does not move the old ones far.
   */
  setData(nodes: CanvasNode<T>[], edges: CanvasEdge<T>[], annotations: CanvasAnnotation[] = [], opts: { refit?: boolean; centreId?: string | null } = {}): void {
    // A new graph starts from a fresh view, centred on its anchor, and follows the layout until
    // it settles or the user pans or zooms. Merging nodes into the same graph keeps the view.
    if (opts.refit) {
      this.fitted = false;
      this.centreId = opts.centreId ?? null;
      this.following = this.opts.simulate;
    }
    this.nodes = nodes;
    this.edges = edges;
    this.annotations = annotations;
    this.neighbours.clear();
    for (const e of edges) {
      this.link(e.a.id, e.b.id);
      this.link(e.b.id, e.a.id);
    }
    if (this.hovered && !nodes.includes(this.hovered)) this.hovered = null;
    if (this.highlighted && !nodes.includes(this.highlighted)) this.highlighted = null;
    if (this.opts.simulate && nodes.length > 0) {
      this.alpha = 1;
      // The first ticks run before the first frame, so the graph never opens as one clump.
      const warm = reducedMotion() ? 320 : nodes.length > 250 ? 20 : 70;
      for (let i = 0; i < warm && this.alpha > ALPHA_MIN; i++) this.tick();
    }
    if (!this.fitted || !this.opts.simulate) this.fit();
    this.fitted = true;
    this.schedule();
  }

  private link(a: string, b: string): void {
    let set = this.neighbours.get(a);
    if (!set) this.neighbours.set(a, (set = new Set()));
    set.add(b);
  }

  select(id: string | null): void {
    this.selectedId = id;
    this.schedule();
  }

  /** Lights a node and its links as if the pointer were on it. `null` clears it. */
  highlight(id: string | null): void {
    const node = id ? (this.nodes.find((n) => n.id === id) ?? null) : null;
    if (node === this.highlighted) return;
    this.highlighted = node;
    this.schedule();
  }

  /** Re-reads the theme colours. Call it when Obsidian's CSS changes. */
  refreshTheme(): void {
    this.colors.clear();
    this.schedule();
  }

  /** Zooms and pans so that the given nodes (all nodes by default) fill the canvas. */
  fit(nodes: CanvasNode<T>[] = this.nodes): void {
    if (nodes.length === 0 || this.width === 0 || this.height === 0) return;
    const centre = this.centreId ? nodes.find((n) => n.id === this.centreId) : undefined;
    if (centre) {
      // The anchor goes to the middle; the zoom fits every node on every side, and leaves room
      // for the labels that always show, which sit outward and keep their size at any zoom.
      const pad = 16;
      const font = getComputedStyle(this.parent).fontFamily || "sans-serif";
      this.ctx.font = `600 12px ${font}`;
      let k = 2.5;
      for (const n of nodes) {
        if (n === centre) continue;
        const dx = Math.abs(n.x - centre.x);
        const dy = Math.abs(n.y - centre.y);
        const labelled = !!n.showLabel || n.id === this.selectedId;
        const shown = n.label.length > 34 ? `${n.label.slice(0, 33)}…` : n.label;
        // A long label in a narrow pane may not fit beside its node; it then gets at most 60% of
        // the half-width, so one label never shrinks the whole graph to a dot.
        const side = labelled && dx > dy ? Math.min(this.ctx.measureText(shown).width + 6, (this.width / 2 - pad) * 0.6) : 0;
        const above = labelled && dx <= dy ? 20 : 0;
        k = Math.min(k, (this.width / 2 - pad - side) / Math.max(1, dx + n.r), (this.height / 2 - pad - above) / Math.max(1, dy + n.r));
      }
      this.k = Math.max(0.05, Math.min(2.5, k));
      this.tx = this.width / 2 - centre.x * this.k;
      this.ty = this.height / 2 - centre.y * this.k;
      this.schedule();
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x - n.r);
      maxX = Math.max(maxX, n.x + n.r);
      minY = Math.min(minY, n.y - n.r);
      maxY = Math.max(maxY, n.y + n.r);
    }
    const pad = 48;
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    this.k = Math.max(0.05, Math.min(2.5, Math.min((this.width - 2 * pad) / w, (this.height - 2 * pad) / h)));
    this.tx = this.width / 2 - ((minX + maxX) / 2) * this.k;
    this.ty = this.height / 2 - ((minY + maxY) / 2) * this.k;
    this.schedule();
  }

  /** Restarts the layout gently, after nodes were added. */
  reheat(alpha = 0.5): void {
    if (!this.opts.simulate) return;
    this.alpha = Math.max(this.alpha, alpha);
    this.schedule();
  }

  // ---------- layout ----------

  private tick(): void {
    const nodes = this.nodes;
    const a = this.alpha;
    const n = nodes.length;
    for (let i = 0; i < n; i++) {
      const p = nodes[i]!;
      for (let j = i + 1; j < n; j++) {
        const q = nodes[j]!;
        let dx = p.x - q.x;
        let dy = p.y - q.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > 640_000) continue;
        if (d2 < 1) {
          // Two nodes on the same spot are pushed apart in a fixed direction.
          dx = ((i * 7 + j) % 5) - 2 || 1;
          dy = ((i + j * 3) % 5) - 2 || 1;
          d2 = dx * dx + dy * dy;
        }
        const f = (REPULSION * a) / d2;
        p.vx = (p.vx ?? 0) + dx * f * 0.05;
        p.vy = (p.vy ?? 0) + dy * f * 0.05;
        q.vx = (q.vx ?? 0) - dx * f * 0.05;
        q.vy = (q.vy ?? 0) - dy * f * 0.05;
      }
    }
    for (const e of this.edges) {
      const dx = e.b.x - e.a.x;
      const dy = e.b.y - e.a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      // A similar pair rests close together; a weak pair rests far apart.
      const rest = 70 + (1 - e.weight) * 240;
      const f = ((d - rest) / d) * a * (0.04 + 0.1 * e.weight);
      e.a.vx = (e.a.vx ?? 0) + dx * f;
      e.a.vy = (e.a.vy ?? 0) + dy * f;
      e.b.vx = (e.b.vx ?? 0) - dx * f;
      e.b.vy = (e.b.vy ?? 0) - dy * f;
    }
    const held = this.drag?.node;
    for (const p of nodes) {
      if (p === held || p.fixed) {
        p.vx = p.vy = 0;
        continue;
      }
      p.vx = ((p.vx ?? 0) - p.x * 0.012 * a) * DAMPING;
      p.vy = ((p.vy ?? 0) - p.y * 0.012 * a) * DAMPING;
      p.x += p.vx;
      p.y += p.vy;
    }
    this.alpha *= ALPHA_DECAY;
  }

  // ---------- drawing ----------

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.opts.simulate && this.alpha > ALPHA_MIN) {
        this.tick();
        if (this.following) this.fit();
        this.schedule();
      } else this.following = false;
      this.draw();
    });
  }

  private resize(): void {
    const rect = this.parent.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    if (w === this.width && h === this.height) return;
    const first = this.width === 0 || this.height === 0;
    // Keep the same world point in the centre of the canvas.
    if (!first) {
      this.tx += (w - this.width) / 2;
      this.ty += (h - this.height) / 2;
    }
    this.width = w;
    this.height = h;
    const dpr = window.devicePixelRatio || 1;
    this.el.width = Math.max(1, Math.floor(w * dpr));
    this.el.height = Math.max(1, Math.floor(h * dpr));
    this.el.style.width = `${w}px`;
    this.el.style.height = `${h}px`;
    if (first) this.fit();
    this.schedule();
  }

  private color(value: string): string {
    if (!value.startsWith("--")) return value;
    let c = this.colors.get(value);
    if (c === undefined) {
      c = getComputedStyle(this.parent).getPropertyValue(value).trim() || "#888";
      this.colors.set(value, c);
    }
    return c;
  }

  private draw(): void {
    const { ctx, k } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (this.nodes.length === 0) return;
    const focus = this.hovered ?? (this.drag?.node || null) ?? this.highlighted;
    const near = focus ? this.neighbours.get(focus.id) : undefined;
    const lit = (n: CanvasNode<T>) => !focus || n === focus || !!near?.has(n.id);
    const accent = this.color("--interactive-accent");
    const line = this.color("--text-muted");
    const text = this.color("--text-normal");
    const faint = this.color("--text-faint");
    const background = this.color("--background-primary");
    // World-to-screen for the visible rectangle, to skip what is off the canvas.
    const left = -this.tx / k;
    const top = -this.ty / k;
    const right = left + this.width / k;
    const bottom = top + this.height / k;

    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * this.tx, dpr * this.ty);
    ctx.lineCap = "round";
    const selected = this.selectedId ? this.nodes.find((n) => n.id === this.selectedId) : undefined;
    for (const e of this.edges) {
      const on = !focus || e.a === focus || e.b === focus;
      if (e.quiet && !(focus && on) && !(selected && (e.a === selected || e.b === selected))) continue;
      ctx.globalAlpha = on ? 0.18 + 0.55 * e.weight : 0.05;
      ctx.strokeStyle = e.strong ? accent : line;
      ctx.lineWidth = (this.opts.uniformEdges ? 1.1 : 0.6 + 2.4 * e.weight * e.weight) / Math.sqrt(k);
      ctx.beginPath();
      ctx.moveTo(e.a.x, e.a.y);
      ctx.lineTo(e.b.x, e.b.y);
      ctx.stroke();
    }
    // Nodes of one colour are drawn in one path each, which keeps ten thousand dots cheap.
    const minR = 1.6 / k;
    const groups = new Map<string, CanvasNode<T>[]>();
    for (const n of this.nodes) {
      if (n.x + n.r < left || n.x - n.r > right || n.y + n.r < top || n.y - n.r > bottom) continue;
      // Opacity is part of the group, rounded so that a graph has only a few groups.
      const alpha = Math.round((n.alpha ?? 0.95) * 20) / 20;
      const key = `${lit(n) ? 1 : 0}|${alpha}|${n.color}`;
      const list = groups.get(key);
      if (list) list.push(n);
      else groups.set(key, [n]);
    }
    for (const [key, list] of groups) {
      const [on, alpha, color] = key.split("|") as [string, string, string];
      ctx.globalAlpha = on === "1" ? Number(alpha) : 0.18 * Number(alpha);
      ctx.fillStyle = this.color(color);
      ctx.beginPath();
      for (const n of list) {
        const r = Math.max(minR, n.r);
        ctx.moveTo(n.x + r, n.y);
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const n of this.nodes) {
      const selected = n.id === this.selectedId;
      if (!n.ring && !selected && n !== focus) continue;
      ctx.strokeStyle = selected || n === focus ? text : accent;
      ctx.lineWidth = (n.ring && !selected && n !== focus ? 2.5 : 2) / k;
      ctx.beginPath();
      ctx.arc(n.x, n.y, Math.max(minR, n.r) + 3 / k, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Labels are drawn in screen space, so their size does not change with the zoom.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    const font = getComputedStyle(this.parent).fontFamily || "sans-serif";
    // With a centre node, a label prefers the side of its node that faces away from the centre, so
    // labels spread outward instead of crossing the spokes; otherwise it sits below the node. In a
    // graph with a centre, each label also takes the first side where it overlaps no label already
    // drawn and not the centre node; a label with no free side is left out (it shows on hover).
    const centre = this.centreId ? this.nodes.find((n) => n.id === this.centreId) : undefined;
    type Side = "above" | "below" | "left" | "right";
    interface Box { x0: number; y0: number; x1: number; y1: number }
    const placed: Box[] = [];
    if (centre) {
      const cx = centre.x * k + this.tx;
      const cy = centre.y * k + this.ty;
      // The centre's ring is drawn 3 px outside its dot, 2–2.5 px wide; labels keep clear of it.
      const cr = Math.max(1.6, centre.r * k) + 6;
      placed.push({ x0: cx - cr, y0: cy - cr, x1: cx + cr, y1: cy + cr });
    }
    const overlaps = (b: Box) => placed.some((p) => b.x0 < p.x1 + LABEL_MARGIN && b.x1 > p.x0 - LABEL_MARGIN && b.y0 < p.y1 + LABEL_MARGIN && b.y1 > p.y0 - LABEL_MARGIN);
    const inside = (b: Box) => b.x0 >= 0 && b.y0 >= 0 && b.x1 <= this.width && b.y1 <= this.height;
    const outward = (n: CanvasNode<T>): Side => {
      if (!centre || n === centre) return "below";
      const dx = n.x - centre.x;
      const dy = n.y - centre.y;
      if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
      return dy < 0 ? "above" : "below";
    };
    const box = (n: CanvasNode<T>, side: Side, w: number): { b: Box; x: number; y: number; align: CanvasTextAlign; base: CanvasTextBaseline } => {
      const sx = n.x * k + this.tx;
      const sy = n.y * k + this.ty;
      const gap = Math.max(1.6, n.r * k) + 5;
      const h = 15;
      if (side === "below") return { b: { x0: sx - w / 2, y0: sy + gap, x1: sx + w / 2, y1: sy + gap + h }, x: sx, y: sy + gap, align: "center", base: "top" };
      if (side === "above") return { b: { x0: sx - w / 2, y0: sy - gap - h, x1: sx + w / 2, y1: sy - gap }, x: sx, y: sy - gap, align: "center", base: "bottom" };
      if (side === "right") return { b: { x0: sx + gap, y0: sy - h / 2, x1: sx + gap + w, y1: sy + h / 2 }, x: sx + gap, y: sy, align: "left", base: "middle" };
      return { b: { x0: sx - gap - w, y0: sy - h / 2, x1: sx - gap, y1: sy + h / 2 }, x: sx - gap, y: sy, align: "right", base: "middle" };
    };
    /** Draws a label. `force` draws it even when every side overlaps, on its preferred side. */
    const label = (n: CanvasNode<T>, strong: boolean, force: boolean): boolean => {
      ctx.font = `${strong ? "600 " : ""}12px ${font}`;
      const shown = n.label.length > 34 ? `${n.label.slice(0, 33)}…` : n.label;
      const w = ctx.measureText(shown).width;
      const first = outward(n);
      const sides: Side[] = [first, ...(["above", "below", "right", "left"] as Side[]).filter((x) => x !== first)];
      let pick = centre ? sides.map((side) => box(n, side, w)).find((c) => !overlaps(c.b) && inside(c.b)) : box(n, first, w);
      if (!pick) {
        if (!force) return false;
        pick = box(n, first, w);
      }
      placed.push(pick.b);
      ctx.textAlign = pick.align;
      ctx.textBaseline = pick.base;
      ctx.lineWidth = 3;
      ctx.strokeStyle = background;
      ctx.strokeText(shown, pick.x, pick.y);
      ctx.fillStyle = strong ? text : faint;
      ctx.fillText(shown, pick.x, pick.y);
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      return true;
    };
    const all = this.opts.labels !== "focus" && (this.nodes.length <= 60 || k >= 1.6);
    // The centre and the selected note always get a label; then the labelled notes, larger
    // (more similar) first; then the rest that are wanted, such as a hovered note's neighbours.
    const wanted = this.nodes.filter((n) => {
      if (n === focus) return false;
      if (n.x < left || n.x > right || n.y < top || n.y > bottom) return false;
      return n.showLabel || n.id === this.selectedId || (focus ? !!near?.has(n.id) : all);
    });
    const rank = (n: CanvasNode<T>) => (n === centre ? 0 : n.id === this.selectedId ? 1 : n.showLabel ? 2 : 3);
    wanted.sort((a, b) => rank(a) - rank(b) || b.r - a.r);
    let drawn = 0;
    for (const n of wanted) {
      if (drawn >= MAX_LABELS) break;
      ctx.globalAlpha = lit(n) ? 1 : 0.25;
      if (label(n, !!n.showLabel || n.id === this.selectedId, rank(n) <= 1)) drawn++;
    }
    ctx.globalAlpha = 1;
    if (this.annotations.length) {
      ctx.textBaseline = "middle";
      ctx.font = `600 ${k > 1.4 ? 15 : 13}px ${font}`;
      for (const a of this.annotations) {
        const x = a.x * k + this.tx;
        const y = a.y * k + this.ty;
        ctx.lineWidth = 4;
        ctx.strokeStyle = background;
        ctx.strokeText(a.text, x, y);
        ctx.fillStyle = text;
        ctx.fillText(a.text, x, y);
      }
      ctx.textBaseline = "top";
    }
    // The note under the pointer is always named, on top of everything else.
    if (focus) label(focus, true, true);
  }

  // ---------- interaction ----------

  private nodeAt(sx: number, sy: number): CanvasNode<T> | null {
    const x = (sx - this.tx) / this.k;
    const y = (sy - this.ty) / this.k;
    // A small node keeps a comfortable target of 8 screen pixels.
    const slack = 8 / this.k;
    let best: CanvasNode<T> | null = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      const dx = n.x - x;
      const dy = n.y - y;
      const d2 = dx * dx + dy * dy;
      const reach = Math.max(n.r, slack);
      if (d2 <= reach * reach && d2 < bestD) {
        best = n;
        bestD = d2;
      }
    }
    return best;
  }

  private setHovered(node: CanvasNode<T> | null): void {
    if (node === this.hovered) return;
    this.hovered = node;
    this.el.style.cursor = node ? "pointer" : "";
    this.schedule();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.following = false;
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
    const k = Math.max(0.05, Math.min(8, this.k * factor));
    // The world point under the cursor stays under the cursor.
    this.tx = e.offsetX - ((e.offsetX - this.tx) / this.k) * k;
    this.ty = e.offsetY - ((e.offsetY - this.ty) / this.k) * k;
    this.k = k;
    this.schedule();
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.el.setPointerCapture(e.pointerId);
    this.drag = { node: this.nodeAt(e.offsetX, e.offsetY), x: e.offsetX, y: e.offsetY, moved: false, id: e.pointerId };
  }

  private onPointerMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) {
      this.setHovered(this.nodeAt(e.offsetX, e.offsetY));
      return;
    }
    const dx = e.offsetX - drag.x;
    const dy = e.offsetY - drag.y;
    if (!drag.moved && dx * dx + dy * dy < 16) return;
    drag.moved = true;
    drag.x = e.offsetX;
    drag.y = e.offsetY;
    this.following = false;
    if (drag.node && this.opts.simulate) {
      drag.node.x += dx / this.k;
      drag.node.y += dy / this.k;
      this.alpha = Math.max(this.alpha, 0.25);
    } else {
      this.tx += dx;
      this.ty += dy;
    }
    this.schedule();
  }

  private onPointerUp(e: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    if (this.el.hasPointerCapture(drag.id)) this.el.releasePointerCapture(drag.id);
    if (drag.moved) return void this.schedule();
    if (drag.node) this.opts.onClick?.(drag.node, e);
    else this.opts.onBackgroundClick?.();
  }

  /** Arrow keys walk through the nodes; Enter opens the selected one; + and - zoom; 0 fits. */
  private onKey(e: KeyboardEvent): void {
    if (this.nodes.length === 0) return;
    const at = this.nodes.findIndex((n) => n.id === this.selectedId);
    if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
      const next = this.nodes[(Math.max(0, at) + (at === -1 ? 0 : step) + this.nodes.length) % this.nodes.length]!;
      this.opts.onClick?.(next, new MouseEvent("click"));
    } else if (e.key === "Enter" && at !== -1) {
      e.preventDefault();
      this.opts.onOpen?.(this.nodes[at]!, e);
    } else if (e.key === "+" || e.key === "=" || e.key === "-") {
      this.following = false;
      const factor = e.key === "-" ? 1 / 1.25 : 1.25;
      const k = Math.max(0.05, Math.min(8, this.k * factor));
      this.tx = this.width / 2 - ((this.width / 2 - this.tx) / this.k) * k;
      this.ty = this.height / 2 - ((this.height / 2 - this.ty) / this.k) * k;
      this.k = k;
      this.schedule();
    } else if (e.key === "0") this.fit();
  }
}
