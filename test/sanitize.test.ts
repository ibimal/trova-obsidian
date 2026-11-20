import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, defaultData } from "../src/settings.js";
import { clampSetting, sanitizeData, storedBoolean, storedNumber } from "../src/state/sanitize.js";
import { DataStore, LocalState } from "../src/state/store.js";

describe("data.json checks", () => {
  it("gives the defaults for a missing file without reporting a problem", () => {
    expect(sanitizeData(null)).toEqual({ data: defaultData(), problems: [] });
    expect(sanitizeData(undefined).problems).toEqual([]);
  });

  it("gives the defaults for a root that is not an object", () => {
    for (const raw of ["text", 42, [1, 2], true]) {
      const { data, problems } = sanitizeData(raw);
      expect(data).toEqual(defaultData());
      expect(problems.length).toBe(1);
    }
  });

  it("keeps sound data exactly", () => {
    const sound = { ...defaultData(), pins: { "v:a.md": ["v:b.md"] }, care: { notDuplicates: ["v:a.md\nv:b.md"], keepUnlinked: ["v:x.md"] } };
    const { data, problems } = sanitizeData(JSON.parse(JSON.stringify(sound)));
    expect(problems).toEqual([]);
    expect(data).toEqual(sound);
  });

  it("repairs settings of the wrong type, out of range, or not among the choices", () => {
    const { data, problems } = sanitizeData({
      settings: { vimKeys: "yes", graphLabels: 99, askDeepSeconds: Number.NaN, askMode: "turbo", typoTolerance: 1, includeGlobs: ["a/**", 3], fieldWeights: { filename: -1, body: 2 }, outsideFolders: [{ name: "x", path: "/x" }, "bad"], unknownKey: 1 },
    });
    const s = data.settings;
    expect(s.vimKeys).toBe(DEFAULT_SETTINGS.vimKeys);
    expect(s.graphLabels).toBe(10);
    expect(s.askDeepSeconds).toBe(DEFAULT_SETTINGS.askDeepSeconds);
    expect(s.askMode).toBe(DEFAULT_SETTINGS.askMode);
    expect(s.typoTolerance).toBe(1);
    expect(s.includeGlobs).toEqual(["a/**"]);
    expect(s.fieldWeights).toEqual({ ...DEFAULT_SETTINGS.fieldWeights, body: 2 });
    expect(s.outsideFolders).toEqual([{ name: "x", path: "/x" }]);
    expect("unknownKey" in s).toBe(false);
    expect(problems.length).toBeGreaterThanOrEqual(7);
  });

  it("drops bad entries from pins, filters, folder context and Vault care, keeping the good ones", () => {
    const { data } = sanitizeData({
      pins: { "v:a.md": ["v:b.md", 5], "v:c.md": "nope" },
      hides: "nope",
      filters: { connections: [{ field: "tag", op: "eq", value: "x" }, { field: "tag", op: "nope", value: "x" }, null] },
      folderContext: { Inbox: "captures", Bad: 3 },
      care: { notDuplicates: ["v:a.md\nv:b.md", "not a pair", 7], keepUnlinked: "nope" },
    });
    expect(data.pins).toEqual({ "v:a.md": ["v:b.md"] });
    expect(data.hides).toEqual({});
    expect(data.filters.connections).toEqual([{ field: "tag", op: "eq", value: "x" }]);
    expect(data.folderContext).toEqual({ Inbox: "captures" });
    expect(data.care).toEqual({ notDuplicates: ["v:a.md\nv:b.md"], keepUnlinked: [] });
  });

  it("clamps typed numbers with the same limits the load check uses", () => {
    expect(clampSetting("httpApiPort", 99_999)).toBe(65_535);
    expect(clampSetting("graphLabels", 4.6)).toBe(5);
    expect(clampSetting("restoreQuerySeconds", 0)).toBe(0);
    expect(clampSetting("vimKeys" as never, 3)).toBe(3);
    // A clamped value passes the load check without a repair.
    expect(sanitizeData({ settings: { httpApiPort: clampSetting("httpApiPort", 99_999) } }).problems).toEqual([]);
  });

  it("reads browser-storage values only when they fit", () => {
    expect(storedNumber(300, 0, 1000, 5)).toBe(300);
    expect(storedNumber("300", 0, 1000, 5)).toBe(5);
    expect(storedNumber(Number.POSITIVE_INFINITY, 0, 1000, 5)).toBe(5);
    expect(storedBoolean(true)).toBe(true);
    expect(storedBoolean("true")).toBeNull();
  });
});

describe("DataStore with a damaged or unreadable file", () => {
  it("starts from the defaults when the file cannot be read, and leaves it alone without a copy", async () => {
    const save = vi.fn(async () => undefined);
    const store = new DataStore({ load: async () => { throw new SyntaxError("Unexpected token"); }, save });
    await store.load();
    expect(store.loadFailed).toBe(true);
    expect(store.data).toEqual(defaultData());
    expect(save).not.toHaveBeenCalled();
  });

  it("copies a damaged file, then saves the repaired data once", async () => {
    const save = vi.fn(async () => undefined);
    const backup = vi.fn(async () => "data.backup-1.json");
    const store = new DataStore({ load: async () => ({ settings: { graphLabels: "ten" } }), save, backup });
    await store.load();
    expect(backup).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(store.backupName).toBe("data.backup-1.json");
    expect(store.data.settings.graphLabels).toBe(DEFAULT_SETTINGS.graphLabels);
  });

  it("neither copies nor saves a sound file", async () => {
    const save = vi.fn(async () => undefined);
    const backup = vi.fn(async () => "x");
    const store = new DataStore({ load: async () => defaultData(), save, backup });
    await store.load();
    expect(backup).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("survives a failed save and tries again", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const store = new DataStore({ load: async () => null, save: async () => { calls++; if (calls === 1) throw new Error("disk full"); } });
      await store.load();
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await expect(store.flush()).resolves.toBeUndefined();
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(2500);
      expect(calls).toBe(2);
      error.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("LocalState with damaged browser storage", () => {
  it("drops bad history entries and survives storage that throws", () => {
    const values: Record<string, unknown> = {
      "trova-history": [{ query: "ok", mode: "auto", at: 1 }, { query: 3 }, "junk"],
      "trova-opened": { "a.md": 5, "b.md": "x" },
    };
    const local = new LocalState({ load: (k) => values[k] ?? null, save: () => { throw new Error("quota"); } });
    expect(local.history()).toEqual([{ query: "ok", mode: "auto", at: 1 }]);
    expect(local.lastOpened("a.md")).toBe(5);
    expect(local.lastOpened("b.md")).toBeUndefined();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => local.set("x", 1)).not.toThrow();
    error.mockRestore();
    const broken = new LocalState({ load: () => { throw new Error("no storage"); }, save: () => undefined });
    expect(broken.history()).toEqual([]);
    expect(broken.get("anything")).toBeNull();
  });
});
