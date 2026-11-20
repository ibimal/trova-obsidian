import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GraphCanvas, type CanvasEdge, type CanvasNode } from "../src/views/graphCanvas.js";
import { labelAngles } from "../src/views/similarityGraph.js";

// The canvas needs a few browser APIs; these stand-ins are enough to run its layout and drawing.
const stubs: Record<string, unknown> = {
  ResizeObserver: class {
    observe(): void {}
    disconnect(): void {}
  },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => undefined,
  getComputedStyle: () => ({ fontFamily: "sans-serif", getPropertyValue: () => "#888" }),
  matchMedia: () => ({ matches: false }),
  window: { devicePixelRatio: 1 },
  document: { createElement: () => ({}) },
};
const saved: Record<string, unknown> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(stubs)) {
    saved[k] = (globalThis as Record<string, unknown>)[k];
    (globalThis as Record<string, unknown>)[k] = v;
  }
});
afterAll(() => {
  for (const k of Object.keys(stubs)) (globalThis as Record<string, unknown>)[k] = saved[k];
});

interface Drawn {
  text: string;
  x: number;
  y: number;
  align: string;
  base: string;
}

/** A 2D context that records every label drawn, with the alignment in force at the time. */
function recordingContext(labelWidth: number, drawn: Drawn[]): CanvasRenderingContext2D {
  const state: Record<string, unknown> = { textAlign: "start", textBaseline: "alphabetic" };
  return new Proxy(state, {
    get: (t, p) => {
      if (p === "measureText") return () => ({ width: labelWidth });
      if (p === "fillText") return (text: string, x: number, y: number) => drawn.push({ text, x, y, align: String(t["textAlign"]), base: String(t["textBaseline"]) });
      if (p in t) return t[p as string];
      return () => undefined;
    },
    set: (t, p, v) => {
      t[p as string] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

interface Case {
  count: number;
  labels: number;
  labelWidth: number;
  width: number;
  height: number;
}

/** Lays out and draws a graph like the drawer's. */
function run(c: Case): { nodes: CanvasNode<number>[]; boxes: { x0: number; y0: number; x1: number; y1: number }[]; centre: { x: number; y: number; ring: number } } {
  const drawn: Drawn[] = [];
  const ctx = recordingContext(c.labelWidth, drawn);
  const el = { addEventListener() {}, setAttribute() {}, removeAttribute() {}, insertAdjacentElement() {}, getContext: () => ctx, style: {}, width: 0, height: 0, remove() {} };
  const parent = { createEl: () => el, getBoundingClientRect: () => ({ width: c.width, height: c.height }) } as unknown as HTMLElement;
  const canvas = new GraphCanvas<number>(parent, { simulate: true, ariaLabel: "graph", labels: "focus", uniformEdges: true });
  const anchor: CanvasNode<number> = { id: "anchor", label: "This note", x: 0, y: 0, r: 11, color: "", fixed: true, data: 1 };
  const slots = labelAngles(c.labels);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const nodes: CanvasNode<number>[] = [anchor];
  const edges: CanvasEdge<number>[] = [];
  for (let i = 0; i < c.count; i++) {
    const score = 0.9 - (i / c.count) * 0.5;
    const weight = (score - 0.3) / 0.7;
    // Like the drawer: the labelled notes start on alternating sides, the rest on a spiral.
    const angle = i < c.labels ? slots[i]! : -Math.PI / 2 + i * golden;
    const d = 120 + (1 - score) * 160;
    const node: CanvasNode<number> = { id: `n${i}`, label: `Note number ${i}`, x: Math.cos(angle) * d, y: Math.sin(angle) * d, r: 4 + 8 * weight, color: "", showLabel: i < c.labels, data: score };
    nodes.push(node);
    edges.push({ a: anchor, b: node, weight });
  }
  // Related notes are also similar to each other, which pulls them sideways.
  for (let i = 1; i < c.count; i++) edges.push({ a: nodes[i]!, b: nodes[i + 1]!, weight: 0.4, quiet: true });
  canvas.setData(nodes, edges, [], { refit: true, centreId: "anchor" });
  const view = canvas as unknown as { tick(): void; fit(): void; draw(): void; k: number; tx: number; ty: number };
  for (let i = 0; i < 400; i++) view.tick();
  view.fit();
  drawn.length = 0;
  view.draw();
  const h = 15;
  const boxes = drawn.map((d) => {
    const x0 = d.align === "center" ? d.x - c.labelWidth / 2 : d.align === "right" ? d.x - c.labelWidth : d.x;
    const y0 = d.base === "top" ? d.y : d.base === "bottom" ? d.y - h : d.y - h / 2;
    return { x0, y0, x1: x0 + c.labelWidth, y1: y0 + h };
  });
  // The current note's ring as drawn: 3 px outside its dot, about 2.5 px wide.
  return { nodes, boxes, centre: { x: view.tx, y: view.ty, ring: anchor.r * view.k + 5 } };
}

const cases: Case[] = [
  { count: 12, labels: 5, labelWidth: 80, width: 320, height: 260 },
  { count: 24, labels: 5, labelWidth: 80, width: 320, height: 260 },
  { count: 60, labels: 5, labelWidth: 80, width: 320, height: 260 },
  { count: 24, labels: 5, labelWidth: 130, width: 320, height: 260 },
  { count: 24, labels: 5, labelWidth: 110, width: 280, height: 180 },
  { count: 60, labels: 10, labelWidth: 80, width: 320, height: 260 },
  { count: 60, labels: 10, labelWidth: 110, width: 240, height: 150 },
];

describe("graph drawer labels", () => {
  it.each(cases)("never draws two labels on top of each other: $count notes, $labels labels, $labelWidth px, $width×$height", (c) => {
    const { boxes, centre } = run(c);
    const clash: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i]!;
      // No label covers the current note's dot.
      if (a.x0 < centre.x + centre.ring && a.x1 > centre.x - centre.ring && a.y0 < centre.y + centre.ring && a.y1 > centre.y - centre.ring) clash.push(`${i}-centre`);
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j]!;
        if (!(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0)) clash.push(`${i}-${j}`);
      }
    }
    expect(clash).toEqual([]);
    if (process.env["LABEL_REPORT"]) console.log(`REPORT ${c.count} notes, ${c.labels} labels, ${c.labelWidth}px, ${c.width}x${c.height}: ${boxes.length} drawn`);
    // Best effort: most of the labels find room in a normal drawer.
    if (c.width >= 320 && c.labelWidth <= 80) expect(boxes.length).toBeGreaterThanOrEqual(Math.ceil(c.labels * 0.6));
  });

  it.each(cases.slice(0, 3))("keeps link length meaning similarity: $count notes", (c) => {
    const { nodes } = run(c);
    const dist = (n: CanvasNode<number>) => Math.hypot(n.x, n.y);
    const related = nodes.slice(1).sort((a, b) => b.data - a.data);
    const strongest = related.slice(0, 5).map(dist);
    const weakest = related.slice(-5).map(dist);
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    // The labelled, most similar notes sit clearly closer than the least similar ones.
    expect(mean(strongest)).toBeLessThan(mean(weakest) * 0.8);
    expect(Math.max(...strongest)).toBeLessThan(Math.max(...weakest));
  });
});
