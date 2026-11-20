import { describe, expect, it } from "vitest";
import type { DuplicatePair } from "@trova/contract";
import { canRerankNow, deepOnEnter, historyTitle, shiftHighlights, stripHeading } from "../src/views/askSession.js";
import { DRAWER_MIN, clampDrawer, duplicateOf } from "../src/views/ConnectionsView.js";
import { strengthLevel } from "../src/views/rows.js";
import { drawWeight, nodeAlpha } from "../src/views/similarityGraph.js";
import { sinceText } from "../src/views/VaultCareView.js";

describe("strength encoding", () => {
  it("fills one bar per level, so the meter reads without colour", () => {
    expect([strengthLevel("loose"), strengthLevel("related"), strengthLevel("strong")]).toEqual([1, 2, 3]);
  });

  it("spreads similarities from the Loose threshold to 1 over the whole drawing range", () => {
    expect(drawWeight(0.3)).toBe(0);
    expect(drawWeight(1)).toBe(1);
    expect(drawWeight(0.1)).toBe(0);
    expect(drawWeight(0.65)).toBeCloseTo(0.5);
    // Two typical scores that the raw value drew almost alike now differ clearly.
    expect(drawWeight(0.8) - drawWeight(0.45)).toBeGreaterThan(0.45);
  });

  it("fills stronger nodes more, and keeps loose nodes visible", () => {
    expect(nodeAlpha("strong")).toBeGreaterThan(nodeAlpha("related"));
    expect(nodeAlpha("related")).toBeGreaterThan(nodeAlpha("loose"));
    expect(nodeAlpha("loose")).toBeGreaterThanOrEqual(0.3);
  });
});

describe("near-duplicate warning", () => {
  const pair = (aPath: string, bPath: string, similarity: number): DuplicatePair => ({ a: aPath, b: bPath, aTitle: aPath, bTitle: bPath, aPath, bPath, kind: "source", similarity });

  it("picks the most similar other note, from either side of a pair", () => {
    const pairs = [pair("a.md", "b.md", 0.91), pair("c.md", "a.md", 0.95), pair("d.md", "e.md", 0.99)];
    expect(duplicateOf(pairs, "a.md")).toMatchObject({ otherId: "c.md", otherTitle: "c.md" });
    expect(duplicateOf(pairs, "b.md")).toMatchObject({ otherId: "a.md" });
    expect(duplicateOf(pairs, "z.md")).toBeNull();
  });

  it("ignores block pairs inside the same note", () => {
    expect(duplicateOf([pair("a.md", "a.md", 0.99)], "a.md")).toBeNull();
  });

  const section = (aPath: string, aHeading: string, bPath: string, bHeading: string, similarity: number): DuplicatePair => ({
    a: `v:${aPath}#${aHeading}`, b: `v:${bPath}#${bHeading}`, aTitle: aPath, bTitle: bPath, aPath, bPath, kind: "block", similarity,
  });

  it("in the Note scope counts only whole-note pairs", () => {
    const pairs = [section("a.md", "harvest", "b.md", "harvest", 0.97), pair("a.md", "d.md", 0.9)];
    expect(duplicateOf(pairs, "a.md")).toMatchObject({ otherTitle: "d.md" });
    expect(duplicateOf(pairs.slice(0, 1), "a.md")).toBeNull();
  });

  it("in the Section scope counts only pairs with that section", () => {
    const pairs = [section("a.md", "harvest", "b.md", "harvest", 0.97), section("c.md", "soil", "a.md", "soil", 0.95), pair("a.md", "d.md", 0.99)];
    expect(duplicateOf(pairs, "a.md", "soil")).toMatchObject({ ownId: "v:a.md#soil", otherId: "v:c.md#soil", otherTitle: "c.md" });
    expect(duplicateOf(pairs, "a.md", "harvest")).toMatchObject({ otherTitle: "b.md" });
    expect(duplicateOf(pairs, "a.md", "pests")).toBeNull();
  });
});

describe("graph drawer", () => {
  it("keeps the drawer between its minimum and the room the list needs", () => {
    expect(clampDrawer(10, 800)).toBe(DRAWER_MIN);
    expect(clampDrawer(300, 800)).toBe(300);
    expect(clampDrawer(790, 800)).toBe(620);
  });
});

describe("answer rows", () => {
  it("drops the heading the row already shows from the start of a snippet", () => {
    expect(stripHeading("# tempo overview Reference taper mileage", "tempo overview")).toBe("Reference taper mileage");
    expect(stripHeading("## Details\nTempo decisions")).toBe("Tempo decisions");
    expect(stripHeading("No heading here", "Details")).toBe("No heading here");
    expect(stripHeading("…mulch overview Soil decisions harvest", "mulch overview")).toBe("Soil decisions harvest");
    expect(stripHeading("…other text", "mulch overview")).toBe("…other text");
    // A snippet that is only its heading stays as it is.
    expect(stripHeading("# Details", "Details")).toBe("# Details");
  });

  it("moves highlights with the stripped snippet", () => {
    const snippet = "# tempo overview Reference taper";
    const shifted = shiftHighlights(snippet, [[2, 7], [27, 32]], "tempo overview");
    expect(shifted).toEqual([[10, 15]]);
    expect(stripHeading(snippet, "tempo overview").slice(10, 15)).toBe("taper");
  });

  it("shows passage searches in history as short, marked entries", () => {
    expect(historyTitle("how should I taper")).toBe("how should I taper");
    const long = historyTitle(`vec: ${"word ".repeat(40)}`);
    expect(long.startsWith("≈ ")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(72);
  });
});

describe("vault care", () => {
  it("says how long ago the last scan ran", () => {
    const now = Date.UTC(2026, 0, 10, 12);
    expect(sinceText(now - 3 * 60_000, now)).toMatch(/3/);
    expect(sinceText(now - 5 * 3_600_000, now)).toMatch(/5/);
    expect(sinceText(now - 4 * 86_400_000, now)).toMatch(/4/);
  });
});

describe("rerank now", () => {
  it("is offered only for a typed question whose rerank ran out of time", () => {
    expect(canRerankNow("how should I taper", "rerank_skipped", "idle")).toBe(true);
    expect(canRerankNow("how should I taper", "rerank_skipped", "failed")).toBe(true);
    expect(canRerankNow("how should I taper", "rerank_skipped", "running")).toBe(false);
    expect(canRerankNow("how should I taper", undefined, "idle")).toBe(false);
    expect(canRerankNow("how should I taper", "model_missing", "idle")).toBe(false);
    // "More like this" has no typed question.
    expect(canRerankNow("", "rerank_skipped", "idle")).toBe(false);
  });
});

describe("reason line", () => {
  it("leads with the score and cuts long lists", async () => {
    const { reasonParts } = await import("../src/views/ConnectionsView.js");
    const parts = reasonParts({ scores: { vec: 0.968 }, why: { keywords: ["soil", "seedling", "trellis", "compost", "mulch", "prune"], links: ["Garden/Compost guide.md", "Soil.md"], tags: ["garden"] } });
    expect(parts).toEqual({
      score: "97% similar",
      rest: ["shares soil, seedling, trellis +3", "links Compost guide +1", "#garden"],
      full: "97% similar · shares soil, seedling, trellis, compost, mulch, prune · links Compost guide, Soil · #garden",
    });
  });

  it("has nothing to show without a score or shared items", async () => {
    const { reasonParts } = await import("../src/views/ConnectionsView.js");
    expect(reasonParts({ scores: {}, why: { keywords: [], links: [], tags: [] } })).toBeNull();
    expect(reasonParts({ scores: { vec: 0.5 } })).toEqual({ score: "50% similar", rest: [], full: "50% similar" });
  });
});


describe("graph label directions", () => {
  it("puts every label beside its node, in a right and a left column", async () => {
    const { labelAngles } = await import("../src/views/similarityGraph.js");
    expect(labelAngles(0)).toEqual([]);
    for (let n = 1; n <= 10; n++) {
      const angles = labelAngles(n);
      expect(angles).toHaveLength(n);
      // Within 45° of level, so the label sits beside the node and grows away from the centre.
      for (const a of angles) expect(Math.abs(Math.cos(a))).toBeGreaterThan(Math.abs(Math.sin(a)));
      expect(angles.filter((a) => Math.cos(a) > 0)).toHaveLength(Math.ceil(n / 2));
    }
  });

  it("spaces each column evenly from top to bottom, strongest first and alternating sides", async () => {
    const { columnSpread, labelAngles } = await import("../src/views/similarityGraph.js");
    for (let n = 2; n <= 10; n++) {
      const angles = labelAngles(n);
      for (const side of [1, -1]) {
        // Height per unit of link length: tan for the right column, -tan for the left one.
        const ys = angles.filter((a) => Math.sign(Math.cos(a)) === side).map((a) => Math.tan(a) * side);
        if (ys.length < 2) continue;
        const gap = (2 * columnSpread(ys.length)) / (ys.length - 1);
        for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeCloseTo(gap);
      }
      expect(Math.cos(angles[0]!)).toBeGreaterThan(0);
      expect(Math.cos(angles[1]!)).toBeLessThan(0);
    }
  });
});

describe("Deep search hint", () => {
  it("offers Deep only when pressing Enter would run it", () => {
    expect(deepOnEnter("tomato soil mix", "auto")).toBe(false);
    expect(deepOnEnter("should I taper early", "auto")).toBe(true);
    expect(deepOnEnter("taper plan?", "auto")).toBe(true);
    expect(deepOnEnter("tomato soil mix", "deep")).toBe(true);
    expect(deepOnEnter("how should I taper", "fast")).toBe(false);
    expect(deepOnEnter("  ", "deep")).toBe(false);
  });
});

describe("typing preview", () => {
  const answer = (title: string) => ({ id: `v:${title}.md`, source: `v:${title}.md`, path: `${title}.md`, title, snippet: "", highlights: [], scores: {}, matchedBy: ["lex" as const], label: "strong" as const });
  async function session(batches: Record<string, { results: ReturnType<typeof answer>[] }[]>) {
    const { AskSession } = await import("../src/views/askSession.js");
    const { DEFAULT_SETTINGS } = await import("../src/settings.js");
    const seen: number[] = [];
    const plugin = {
      settings: DEFAULT_SETTINGS,
      local: { addHistory() {} },
      knownKeys: () => undefined,
      engine: {
        ready: true,
        collections: () => ["v"],
        async *ask(req: { query: { raw: string } }) {
          for (const b of batches[req.query.raw] ?? []) yield { stage: "lex", final: false, ...b };
          yield { stage: "fused", final: true, results: (batches[req.query.raw] ?? []).at(-1)?.results ?? [] };
        },
      },
    };
    const s = new AskSession(plugin as never, { listEl: () => ({ querySelectorAll: () => [] }) as never, changed: () => seen.push(s.results.length), wireRow() {}, selectedPath: () => null });
    return { s, seen };
  }

  it("keeps the previous answers until the new question's first batch, then replaces them", async () => {
    const { s, seen } = await session({ "soil mix": [{ results: [answer("A"), answer("B")] }], "soil mixes": [{ results: [answer("C")] }] });
    await s.run("soil mix", { mode: "fast", record: false, preview: true });
    expect(s.results.map((r) => r.title)).toEqual(["A", "B"]);
    seen.length = 0;
    await s.run("soil mixes", { mode: "fast", record: false, preview: true });
    // The list never went empty between the two questions.
    expect(seen.every((n) => n > 0)).toBe(true);
    expect(s.results.map((r) => r.title)).toEqual(["C"]);
  });

  it("never shows the previous answers for a question that finds nothing", async () => {
    const { s } = await session({ "soil mix": [{ results: [answer("A")] }], zzz: [] });
    await s.run("soil mix", { mode: "fast", record: false, preview: true });
    await s.run("zzz", { mode: "fast", record: false, preview: true });
    expect(s.results).toEqual([]);
  });
});

describe("Instant search Ask row", () => {
  it("appears for question-like queries only", async () => {
    const { offersAsk } = await import("../src/views/InstantModal.js");
    expect(offersAsk("how should I taper before a race")).toBe(true);
    expect(offersAsk("taper plan?")).toBe(true);
    expect(offersAsk("should I taper early")).toBe(true);
    expect(offersAsk("tomato soil")).toBe(false);
    expect(offersAsk("")).toBe(false);
    // A "?" query is already an Ask; filters alone are not a question.
    expect(offersAsk("? how should I taper")).toBe(false);
    expect(offersAsk("tag:garden")).toBe(false);
  });
});

describe("vault care", () => {
  const pair = (a: string, b: string, similarity = 0.9): DuplicatePair => ({ a, b, aTitle: a, bTitle: b, aPath: a, bPath: b, kind: "source", similarity });

  it("splits pairs into shown and dismissed, in either order of the pair", async () => {
    const { splitPairs } = await import("../src/views/VaultCareView.js");
    const { pairKey } = await import("../src/settings.js");
    const off = new Set([pairKey("v:b.md", "v:a.md")]);
    const { active, dismissed } = splitPairs([pair("v:a.md", "v:b.md"), pair("v:c.md", "v:d.md")], (a, b) => off.has(pairKey(a, b)));
    expect(active.map((p) => p.a)).toEqual(["v:c.md"]);
    expect(dismissed.map((p) => p.a)).toEqual(["v:a.md"]);
  });

  it("makes a short excerpt without front matter or a leading heading", async () => {
    const { excerpt } = await import("../src/views/VaultCareView.js");
    expect(excerpt("---\ntags: [a]\n---\n# Title\nFirst line.\n\nSecond   line.")).toBe("First line. Second line.");
    const long = excerpt("word ".repeat(80), 40);
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(41);
  });

  it("remembers dismissals, and keeps them when a note is renamed or drops them when it is deleted", async () => {
    const { DataStore } = await import("../src/state/store.js");
    const store = new DataStore({ load: async () => null, save: async () => undefined });
    store.setNotDuplicate("v:a.md", "v:b.md#x", true);
    store.setKeptUnlinked("v:inbox.md", true);
    expect(store.isNotDuplicate("v:b.md#x", "v:a.md")).toBe(true);
    expect(store.isKeptUnlinked("v:inbox.md")).toBe(true);
    store.renameSource("v:b.md", "v:notes/b.md");
    store.renameSource("v:inbox.md", "v:Inbox.md");
    expect(store.isNotDuplicate("v:a.md", "v:notes/b.md#x")).toBe(true);
    expect(store.isKeptUnlinked("v:Inbox.md")).toBe(true);
    store.removeSource("v:a.md");
    expect(store.data.care.notDuplicates).toEqual([]);
    store.setKeptUnlinked("v:Inbox.md", false);
    expect(store.isKeptUnlinked("v:Inbox.md")).toBe(false);
  });

  it("loads saved choices and fills them in for older data files", async () => {
    const { DataStore } = await import("../src/state/store.js");
    const old = new DataStore({ load: async () => ({ settings: {} }), save: async () => undefined });
    await old.load();
    expect(old.data.care).toEqual({ notDuplicates: [], keepUnlinked: [] });
    const saved = new DataStore({ load: async () => ({ care: { notDuplicates: ["v:a.md\nv:b.md"], keepUnlinked: ["v:x.md"] } }), save: async () => undefined });
    await saved.load();
    expect(saved.isNotDuplicate("v:b.md", "v:a.md")).toBe(true);
    expect(saved.isKeptUnlinked("v:x.md")).toBe(true);
  });
});

describe("rediscover age", () => {
  it("names the largest whole unit", async () => {
    const { agoText } = await import("../src/views/VaultCareView.js");
    expect(agoText(12)).toMatch(/12/);
    expect(agoText(12)).toMatch(/day/);
    expect(agoText(244)).toMatch(/8/);
    expect(agoText(244)).toMatch(/month/);
    expect(agoText(800)).toMatch(/2/);
    expect(agoText(800)).toMatch(/year/);
  });
});
