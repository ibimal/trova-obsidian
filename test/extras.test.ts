import { describe, expect, it } from "vitest";
import { parseQuery, type GraphNode, type GraphResponse } from "@trova/contract";
import { GraphModel } from "../src/views/similarityGraph.js";
import { SearchIndex, type WorkerDoc } from "../src/worker/index.js";
import { fixtureDocs } from "./fixture-docs.js";

const q = (raw: string) => parseQuery(raw).query;

describe("worker: updates that skip the re-index", () => {
  it("keeps body matches when only links or dates change, and follows a changed title", () => {
    const index = new SearchIndex();
    const { docs, bodies } = fixtureDocs();
    index.upsertMeta(docs);
    index.upsertBodies(bodies);
    const kanata = docs.find((d) => d.path === "Tools/Kanata.md")!;
    // Same indexed text: the document is replaced without touching the search index.
    index.upsertMeta([{ ...kanata, modified: 999_999, links: [], wordCount: 0 }]);
    expect(index.search(q("udev rule")).body[0]!.path).toBe("Tools/Kanata.md");
    expect(index.search(q("kanata")).title[0]!.modified).toBe(999_999);
    // A new alias changes the indexed text, so the note is re-indexed.
    index.upsertMeta([{ ...kanata, aliases: [...kanata.aliases, "Zebrafinch"] }]);
    expect(index.search(q("zebrafinch")).title[0]).toMatchObject({ path: "Tools/Kanata.md", field: "alias" });
    expect(index.search(q("udev rule")).body[0]!.path).toBe("Tools/Kanata.md");
  });

  it("puts live editor text into the overlay and ignores an unchanged body", () => {
    const index = new SearchIndex();
    const { docs, bodies } = fixtureDocs();
    index.upsertMeta(docs);
    index.upsertBodies(bodies);
    const body = bodies.find((b) => b.path === "Tools/Kanata.md")!.body;
    index.upsertBodies([{ path: "Tools/Kanata.md", body }], false);
    expect(index.stats().dirty).toBe(0);
    index.upsertBodies([{ path: "Tools/Kanata.md", body: `${body}\nquokkaword just typed` }], true);
    expect(index.stats().dirty).toBe(1);
    expect(index.search(q("quokkaword"), { bodies: "overlay" }).body.map((h) => h.path)).toEqual(["Tools/Kanata.md"]);
  });
});

describe("worker: speed on a 10,000-note vault", () => {
  const WORDS = "garden tomato compost keyboard layout remap engine vector search index chunk embedding rerank fusion budget invoice travel flight hotel recipe bread yeast flour meeting agenda decision roadmap release kernel driver latency cache queue worker thread parser grammar token lexer".split(" ");
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const word = () => WORDS[Math.floor(rand() * WORDS.length)]!;
  const text = (n: number) => Array.from({ length: n }, word).join(" ");
  const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

  it("answers a keystroke within the budget and reports the timings", () => {
    const index = new SearchIndex();
    const docs: WorkerDoc[] = [];
    const bodies: { path: string; body: string }[] = [];
    for (let i = 0; i < 10_000; i++) {
      const path = `Area ${i % 40}/${word()} ${word()} ${i}.md`;
      docs.push({ path, title: path.slice(path.indexOf("/") + 1, -3), aliases: [], tags: [word()], links: [], frontmatter: {}, created: 1, modified: i, wordCount: 300, excluded: false, headings: [{ text: `${word()} ${word()}`, level: 2, offset: 0 }] });
      bodies.push({ path, body: `## ${word()} ${word()}\n\n${text(150)}\n\n## ${word()}\n\n${text(150)}\n` });
    }
    const t0 = performance.now();
    index.upsertMeta(docs);
    const metaMs = performance.now() - t0;
    const t1 = performance.now();
    for (let i = 0; i < bodies.length; i += 50) index.upsertBodies(bodies.slice(i, i + 50));
    const bodyMs = performance.now() - t1;

    // Typing "tomato compost" one letter at a time, against title lane plus all bodies, then the overlay only.
    const typed = ["t", "to", "tom", "toma", "tomat", "tomato", "tomato c", "tomato co", "tomato comp", "tomato compost", "keyboard remap", "vector search index", "rerank fusion"];
    const all: number[] = [];
    const overlay: number[] = [];
    for (let round = 0; round < 3; round++) {
      for (const raw of typed) {
        let s = performance.now();
        index.search(q(raw), { bodies: "all", limit: 50 });
        all.push(performance.now() - s);
        s = performance.now();
        index.search(q(raw), { bodies: "overlay", limit: 50 });
        overlay.push(performance.now() - s);
      }
    }
    const typo: number[] = [];
    for (const raw of ["tomatoe compost", "keybaord remap", "embeding index"]) {
      const s = performance.now();
      const reply = index.search(q(raw), { bodies: "all", limit: 50, fuzzy: 1 });
      typo.push(performance.now() - s);
      expect(reply.title.length + reply.body.length).toBeGreaterThan(0);
    }
    const s = performance.now();
    index.upsertBodies([{ path: bodies[5]!.path, body: `${bodies[5]!.body}\nfreshlytypedword` }], true);
    const editMs = performance.now() - s;
    expect(index.search(q("freshlytypedword"), { bodies: "overlay" }).body.length).toBe(1);

    const report = {
      "meta pass, 10,000 files (ms)": Math.round(metaMs),
      "body pass per 50-file batch (ms)": +(bodyMs / 200).toFixed(1),
      "search, all bodies p50 / p95 (ms)": `${percentile(all, 0.5).toFixed(1)} / ${percentile(all, 0.95).toFixed(1)}`,
      "search, title + overlay p50 / p95 (ms)": `${percentile(overlay, 0.5).toFixed(1)} / ${percentile(overlay, 0.95).toFixed(1)}`,
      "typo rescue max (ms)": +Math.max(...typo).toFixed(1),
      "fresh edit indexed (ms)": +editMs.toFixed(1),
    };
    console.log(`WORKER-PERF ${JSON.stringify(report)}`);
    // With the engine running, the worker serves the title lane and the overlay: budget 30 ms at p95.
    expect(percentile(overlay, 0.95)).toBeLessThan(30);
    expect(editMs).toBeLessThan(50);
  }, 120_000);
});

describe("similarity graph model", () => {
  const node = (id: string, score: number): GraphNode => ({ id, path: `${id}.md`, title: id, collection: "v", score, label: score >= 0.6 ? "strong" : "related", snippet: "", tags: [] });
  const response = (anchor: string, others: [string, number][], between: [string, string, number][] = []): GraphResponse => ({
    anchorIndexed: true,
    anchor: node(anchor, 1),
    nodes: others.map(([id, score]) => node(id, score)),
    edges: [...others.map(([id, score]) => ({ a: anchor, b: id, similarity: score, linked: false })), ...between.map(([a, b, similarity]) => ({ a, b, similarity, linked: true }))],
  });

  it("merges an expansion without duplicating nodes or edges", () => {
    const model = new GraphModel();
    expect(model.merge(response("A", [["B", 0.7], ["C", 0.5]], [["B", "C", 0.55]]), true)).toEqual(["A", "B", "C"]);
    expect(model.nodes.get("A")).toMatchObject({ anchor: true, expanded: true, score: 1 });
    expect(model.edges.size).toBe(3);
    // Expanding B finds A and C again, plus D.
    expect(model.merge(response("B", [["A", 0.7], ["C", 0.6], ["D", 0.48]]), false)).toEqual(["D"]);
    expect(model.nodes.size).toBe(4);
    expect(model.nodes.get("B")).toMatchObject({ anchor: false, expanded: true, score: 0.7 });
    expect(model.nodes.get("C")!.score).toBe(0.6);
    // A-B and B-C exist once each; B-C keeps the higher similarity.
    expect(model.edges.size).toBe(4);
    expect([...model.edges.values()].find((e) => [e.a, e.b].sort().join() === "B,C")!.similarity).toBe(0.6);
  });
});
