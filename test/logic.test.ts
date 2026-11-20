import { describe, expect, it, vi } from "vitest";
import { parseQuery, type Result, type ResultBatch, type SearchRequest } from "@trova/contract";
import { rankLinkSuggestions } from "../src/editor/linkSuggest.js";
import { EngineManager, RETRY_SCHEDULE_MS, type EngineSnapshot } from "../src/engine/manager.js";
import { rowToResult } from "../src/features/api.js";
import { parseSavedSearch } from "../src/features/savedSearch.js";
import { QueryController, fuseLanes, mergeBelow, stableOrder, type InstantState, type Row } from "../src/query/controller.js";
import { defaultData } from "../src/settings.js";
import { DataStore, LocalState, Lru, SAVE_DEBOUNCE_MS, renameId } from "../src/state/store.js";
import { sectionAt } from "../src/views/ConnectionsView.js";
import { statusLine } from "../src/views/StatusBar.js";
import { startInline } from "../src/worker/host.js";
import { fixtureDocs } from "./fixture-docs.js";

const C = "vault-test0001";
const row = (path: string, extra: Partial<Row> = {}): Row => ({
  id: `${C}:${path}`, collection: C, path, title: path.replace(/\.md$/, ""), titleHighlights: [], snippet: "", highlights: [], headings: [], matchedBy: ["lex"], score: 0, modified: 0, ...extra,
});

describe("lane fusion", () => {
  it("weights the title lane 2 and the others 1", () => {
    const fused = fuseLanes({ title: [row("b.md")], body: [row("a.md"), row("b.md")], engine: [row("a.md")] }, () => null, false);
    expect(fused.map((r) => r.path)).toEqual(["b.md", "a.md"]);
    expect(fused[0]!.score).toBeCloseTo(2 / 61 + 1 / 62);
    expect(fused[1]!.score).toBeCloseTo(1 / 61 + 1 / 61);
  });
  it("applies the recency multiplier, then breaks ties by modified time and path", () => {
    const lanes = { title: [], body: [row("old.md")], engine: [row("new.md")] };
    expect(fuseLanes(lanes, (p) => (p === "new.md" ? 0 : null), true).map((r) => r.path)).toEqual(["new.md", "old.md"]);
    const tie = fuseLanes({ title: [], body: [row("b.md", { modified: 5 })], engine: [row("a.md", { modified: 9 })] }, () => null, false);
    expect(tie.map((r) => r.path)).toEqual(["a.md", "b.md"]);
    const tie2 = fuseLanes({ title: [], body: [row("b.md")], engine: [row("a.md")] }, () => null, false);
    expect(tie2.map((r) => r.path)).toEqual(["a.md", "b.md"]);
  });
  it("merges row data across lanes: title highlights, block and badges", () => {
    const fused = fuseLanes(
      { title: [row("a.md", { titleHighlights: [[0, 1]] })], body: [], engine: [row("a.md", { snippet: "body text", blockId: `${C}:a.md#x`, headings: ["X"], matchedBy: ["fuzzy"] })] },
      () => null,
      false,
    );
    expect(fused).toHaveLength(1);
    expect(fused[0]).toMatchObject({ snippet: "body text", blockId: `${C}:a.md#x`, titleHighlights: [[0, 1]], matchedBy: ["fuzzy", "lex"] });
  });
  it("keeps the selected or hovered row at its index when an update arrives", () => {
    expect(stableOrder(["a", "b", "c"], ["c", "b", "a", "d"], "b")).toEqual(["c", "b", "a", "d"]);
    expect(stableOrder(["a", "b", "c"], ["b", "c", "a"], "a")).toEqual(["a", "b", "c"]);
    expect(stableOrder(["a", "b"], ["x", "y"], "a")).toEqual(["x", "y"]);
    expect(stableOrder(["a"], ["b", "a"], null)).toEqual(["b", "a"]);
  });
});

function makeController(engineReady: boolean, engineResults: Record<string, Result[]> = {}, delay = 0, timing: { coalesceMs?: number; settleMs?: number } = {}) {
  const worker = startInline();
  const { docs, bodies } = fixtureDocs();
  const calls: SearchRequest[] = [];
  const controller = new QueryController({
    worker,
    engine: {
      ready: engineReady,
      has: () => engineReady,
      async *search(req: SearchRequest, signal?: AbortSignal): AsyncGenerator<ResultBatch> {
        calls.push(req);
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (signal?.aborted) return;
        yield { stage: req.lanes[0] === "vec" ? "vec" : "lex", results: engineResults[req.lanes[0]!] ?? [], final: true };
      },
    },
    vaultCollection: () => C,
    collections: () => [C],
    settings: () => ({ typoTolerance: 1, recencyBoost: true, semanticRows: true, fieldWeights: { filename: 4, aliases: 3, headings: 2, body: 1 } }),
    daysSinceOpened: () => null,
    knownKeys: () => undefined,
    semanticDelayMs: 5,
    ...timing,
  });
  const ready = (async () => {
    await worker.upsertMeta(docs);
    await worker.upsertBodies(bodies, false);
  })();
  const run = async (raw: string) => {
    await ready;
    const states: InstantState[] = [];
    await new Promise<void>((resolve) => {
      controller.run(raw, (s) => {
        states.push(s);
        if (!s.pending && !s.refining) resolve();
      });
    });
    return states;
  };
  return { controller, run, calls, worker, ready };
}

const engineResult = (path: string, by: Result["matchedBy"] = ["lex"]): Result => ({
  id: `${C}:${path}#`, source: `${C}:${path}`, path, title: path, collection: C, snippet: "from engine", highlights: [], scores: {}, matchedBy: by, label: "related",
});

describe("QueryController", () => {
  it("paints once when both keyword lanes answer within the wait", async () => {
    const { run } = makeController(true, { lex: [engineResult("Tools/Kanata.md"), engineResult("Papers/Fusion.pdf")] }, 10, { coalesceMs: 60 });
    const states = await run("kanata");
    // One list, and it already has the engine's notes: no second, reordered paint.
    const withRows = states.filter((s) => s.rows.length > 0);
    expect(withRows).toHaveLength(1);
    expect(withRows[0]!.rows.map((r) => r.path)).toContain("Papers/Fusion.pdf");
  });
  it("adds a late engine lane below the shown rows, then shows the full ranking after a pause", async () => {
    const { controller, ready } = makeController(true, { lex: [engineResult("Papers/Fusion.pdf"), engineResult("Tools/Kanata.md")] }, 60, { coalesceMs: 10, settleMs: 30 });
    await ready;
    const states: InstantState[] = [];
    controller.run("kanata", (s) => states.push(s));
    await new Promise((r) => setTimeout(r, 160));
    const [first, merged, settled] = states.filter((s) => s.rows.length > 0);
    // First paint: the worker's rows, while the engine is still out.
    expect(first!.pending).toBe(true);
    expect(first!.rows.map((r) => r.path)).not.toContain("Papers/Fusion.pdf");
    // The engine's extra note joins below; the rows already on screen keep their places.
    const shown = first!.rows.map((r) => r.path);
    expect(merged!.rows.slice(0, shown.length).map((r) => r.path)).toEqual(shown);
    expect(merged!.rows.map((r) => r.path)).toContain("Papers/Fusion.pdf");
    // After the pause, the full ranking.
    expect(settled).toBeDefined();
    expect(settled!.pending).toBe(false);
  });
  it("merges below without reordering or changing the rows on screen", () => {
    const row = (id: string, snippet: string): Row => ({ id, collection: C, path: id, title: id, titleHighlights: [], snippet, highlights: [], headings: [], matchedBy: ["lex"], score: 0, modified: 0 });
    const out = mergeBelow([row("a", "first a"), row("b", "first b")], [row("c", "c"), row("b", "new b"), row("a", "new a")]);
    expect(out.map((r) => [r.id, r.snippet])).toEqual([["a", "first a"], ["b", "first b"], ["c", "c"]]);
    // A shown row that the new list dropped goes.
    expect(mergeBelow([row("a", "x"), row("z", "y")], [row("a", "x")]).map((r) => r.id)).toEqual(["a"]);
  });
  it("answers from the worker alone when the engine is off, searching all bodies", async () => {
    const { run, calls } = makeController(false);
    const states = await run("udev rule");
    const last = states[states.length - 1]!;
    expect(last.rows[0]!.path).toBe("Tools/Kanata.md");
    expect(last.pending).toBe(false);
    expect(calls).toEqual([]);
  });
  it("fans out to the engine lex lane and merges on the source id", async () => {
    const { run, calls } = makeController(true, { lex: [engineResult("Tools/Kanata.md"), engineResult("Papers/Fusion.pdf")] });
    const last = (await run("kanata")).pop()!;
    expect(calls[0]!.lanes).toEqual(["lex"]);
    expect(last.rows[0]!.path).toBe("Tools/Kanata.md");
    expect(last.rows.filter((r) => r.path === "Tools/Kanata.md")).toHaveLength(1);
    expect(last.rows.map((r) => r.path)).toContain("Papers/Fusion.pdf");
  });
  it("adds semantic rows for queries of three or more words, without rows that are already shown", async () => {
    const { run, calls } = makeController(true, { lex: [engineResult("Trova.md")], vec: [engineResult("Trova.md", ["vec"]), engineResult("Orphan.md", ["vec"])] });
    const last = (await run("trova search engine")).pop()!;
    expect(calls.map((c) => c.lanes[0])).toEqual(["lex", "vec"]);
    expect(last.semantic.map((r) => r.path)).toEqual(["Orphan.md"]);
    expect(last.refining).toBe(false);
    const short = makeController(true, { vec: [engineResult("Orphan.md", ["vec"])] });
    await short.run("trova engine");
    expect(short.calls.map((c) => c.lanes[0])).toEqual(["lex"]);
  });
  it("a new query aborts the previous one, so a stale result never arrives", async () => {
    const { controller, ready } = makeController(true, { lex: [engineResult("Trova.md")] }, 40);
    await ready;
    const first: InstantState[] = [];
    controller.run("trova", (s) => first.push(s));
    const done = new Promise<InstantState>((resolve) => controller.run("kanata", (s) => !s.pending && resolve(s)));
    const last = await done;
    expect(last.raw).toBe("kanata");
    await new Promise((r) => setTimeout(r, 80));
    expect(first.every((s) => s.pending)).toBe(true);
  });
  it("reports diagnostics, corrections and leaves ask queries to Ask", async () => {
    const { run } = makeController(false);
    const bad = (await run("kanata is:banana")).pop()!;
    expect(bad.diagnostics[0]).toMatchObject({ code: "bad_value" });
    expect(bad.rows[0]!.path).toBe("Tools/Kanata.md");
    const typo = (await run("lighthuose")).pop()!;
    expect(typo.correction).toEqual({ from: "lighthuose", to: "lighthouse" });
    expect(typo.rows[0]!.matchedBy).toEqual(["fuzzy"]);
    expect((await run("? what is kanata")).pop()!.rows).toEqual([]);
  });
});

describe("data.json store", () => {
  it("debounces writes by one second and never writes on a change alone", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => undefined);
    const store = new DataStore({ load: async () => null, save });
    await store.load();
    store.setPinned("v:a.md", "v:b.md", true);
    store.setPinned("v:a.md", "v:c.md", true);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
  it("merges saved data with the defaults", async () => {
    const store = new DataStore({ load: async () => ({ settings: { vimKeys: true }, pins: { a: ["b"] } }), save: async () => undefined });
    await store.load();
    expect(store.settings.vimKeys).toBe(true);
    expect(store.settings.contextWarnTokens).toBe(32000);
    expect(store.data.schema).toBe(1);
    expect(store.data.hides).toEqual({});
    expect(defaultData().settings.askMode).toBe("auto");
  });
  it("rewrites pins and hides on rename, for anchors and results, and keeps heading paths", async () => {
    const store = new DataStore({ load: async () => null, save: async () => undefined });
    await store.load();
    store.setPinned("v:Old.md", "v:Other.md#a/b", true);
    store.setHidden("v:Third.md", "v:Old.md", true);
    store.setHidden("v:Third.md", "v:Old.md#intro", true);
    store.renameSource("v:Old.md", "v:New.md");
    expect(store.pins("v:New.md")).toEqual(["v:Other.md#a/b"]);
    expect(store.pins("v:Old.md")).toEqual([]);
    expect(store.hides("v:Third.md")).toEqual(["v:New.md", "v:New.md#intro"]);
    expect(renameId("v:Older.md", "v:Old.md", "v:New.md")).toBe("v:Older.md");
    store.removeSource("v:New.md");
    expect(store.data.pins).toEqual({});
    expect(store.data.hides).toEqual({});
    await store.flush();
  });
  it("keeps per-device state apart: history, opened times and an LRU of 200 anchors", () => {
    const mem = new Map<string, unknown>();
    const local = new LocalState({ load: (k) => mem.get(k) ?? null, save: (k, v) => void mem.set(k, v) });
    local.addHistory({ query: "a", mode: "auto", at: 1 });
    local.addHistory({ query: "b", mode: "deep", at: 2 });
    local.addHistory({ query: "a", mode: "fast", at: 3 });
    expect(local.history().map((h) => h.query)).toEqual(["a", "b"]);
    local.markOpened("x.md", 1000);
    expect(local.daysSinceOpened("x.md", 1000 + 86_400_000)).toBe(1);
    expect(local.daysSinceOpened("never.md")).toBeNull();
    const lru = new Lru<number, number>(200);
    for (let i = 0; i < 250; i++) lru.set(i, i);
    expect(lru.size).toBe(200);
    expect(lru.get(0)).toBeUndefined();
    expect(lru.get(249)).toBe(249);
  });
});

describe("engine lifecycle", () => {
  const host = (over: Record<string, unknown> = {}) => ({
    desktop: true, mode: () => "managed" as const, endpoint: () => null, findBinary: () => null,
    spawn: () => ({ errorOutput: () => "", exited: () => true }), collections: async () => [], mayIndex: () => true, log: () => undefined, ...over,
  });
  it("is disabled on mobile and never blocks the caller", () => {
    const m = new EngineManager(host({ desktop: false }));
    m.start();
    expect(m.snapshot.state).toBe("disabled");
    expect(m.ready).toBe(false);
  });
  it("reports not-found when the binary is missing, then retries after 1, 2, 4, 8 and 30 seconds", async () => {
    vi.useFakeTimers();
    const findBinary = vi.fn(() => null);
    const m = new EngineManager(host({ findBinary }));
    const states: EngineSnapshot["state"][] = [];
    m.onChange((s) => states.push(s.state));
    m.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.snapshot.state).toBe("not-found");
    expect(findBinary).toHaveBeenCalledTimes(1);
    let calls = 1;
    for (const delay of [...RETRY_SCHEDULE_MS, 30_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(findBinary).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(findBinary).toHaveBeenCalledTimes(++calls);
    }
    m.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(findBinary).toHaveBeenCalledTimes(calls);
    vi.useRealTimers();
  });
  it("status bar text follows the states table", () => {
    const idle = { done: 0, total: 0, running: false };
    const base = { api: "1.0", engine: { name: "trova", version: "0.1.0", backend: "qmd" }, capabilities: [], collections: [], jobs: [] };
    const models = (state: "ready" | "downloading", progress?: number) => ({ embed: { state, progress }, rerank: { state: "missing" as const }, expand: { state: "missing" as const } });
    expect(statusLine({ state: "ready", status: { ...base, models: models("ready") } }, idle, true).text).toBe("Trova");
    expect(statusLine({ state: "ready", progress: { kind: "embed", done: 1240, total: 9800 }, status: { ...base, models: models("ready") } }, idle, true).text).toBe("Trova 1,240 / 9,800");
    expect(statusLine({ state: "ready", status: { ...base, models: models("downloading", 0.45) } }, idle, true).text).toBe("Trova: model 45%");
    expect(statusLine({ state: "ready", status: { ...base, models: models("ready"), paused: true } }, idle, true).text).toBe("Trova paused");
    expect(statusLine({ state: "offline", reason: "x" }, idle, true).text).toBe("Trova: engine off");
    expect(statusLine({ state: "ready", error: "boom" }, idle, true).text).toBe("Trova: error");
    expect(statusLine({ state: "disabled" }, { done: 50, total: 200, running: true }, false).text).toBe("Trova 50 / 200");
    expect(statusLine({ state: "disabled" }, idle, false).text).toBe("Trova");
  });
});

describe("small pure helpers", () => {
  it("parses saved-search blocks", () => {
    expect(parseSavedSearch("kanata tag:#tools\nlimit: 5\nmode: ask")).toEqual({ query: "kanata tag:#tools", limit: 5, mode: "ask" });
    expect(parseSavedSearch("? what is fusion")).toEqual({ query: "what is fusion", limit: 10, mode: "ask" });
    expect(parseSavedSearch("status:active")).toEqual({ query: "status:active", limit: 10, mode: "instant" });
    expect(parseQuery(parseSavedSearch("status:active").query).query.filters).toHaveLength(1);
  });
  it("ranks link suggestions by 0.5 x title rank score + 0.5 x similarity", () => {
    const ranked = rankLinkSuggestions(
      [{ path: "a.md", title: "Kanata", score: 10 }, { path: "b.md", title: "Kanban", score: 8 }],
      new Map([["b.md", 0.9]]),
    );
    expect(ranked.map((r) => r.path)).toEqual(["b.md", "a.md"]);
    expect(ranked[0]!.score).toBeCloseTo(0.5 * 0.8 + 0.5 * 0.9);
    expect(ranked[1]!.score).toBeCloseTo(0.5);
  });
  it("finds the section under the cursor with the same heading paths as the engine", () => {
    const headings = [
      { heading: "Setup", level: 1, line: 6 },
      { heading: "Install", level: 2, line: 9 },
      { heading: "Install", level: 2, line: 12 },
      { heading: "Usage", level: 1, line: 15 },
    ];
    expect(sectionAt(headings, 0)).toEqual({ headingPath: "", headings: [] });
    expect(sectionAt(headings, 10).headingPath).toBe("setup/install");
    expect(sectionAt(headings, 13)).toEqual({ headingPath: "setup/install~2", headings: ["Setup", "Install"] });
    expect(sectionAt(headings, 99).headingPath).toBe("usage");
  });
  it("converts rows to public API results", () => {
    const r = rowToResult(row("a.md", { blockId: `${C}:a.md#x`, headings: ["X"], score: 0.03 }), 1);
    expect(r).toMatchObject({ id: `${C}:a.md#x`, source: `${C}:a.md`, label: "strong", block: { headings: ["X"] } });
  });
});
