import { describe, expect, it } from "vitest";
import type { Hotkey } from "obsidian";
import { SUGGESTED_HOTKEYS, hotkeyId, hotkeyKeys, hotkeyRows } from "../src/hotkeys.js";

const hk = (modifiers: Hotkey["modifiers"], key: string): Hotkey => ({ modifiers, key });

describe("suggested hotkeys", () => {
  it("suggests a combination only while no command uses it", () => {
    const rows = hotkeyRows("trova", SUGGESTED_HOTKEYS, {}, {}, true);
    expect(rows.map((r) => [r.command, r.assigned])).toEqual([
      ["instant-search", false],
      ["ask", false],
    ]);
    // Another command's default takes Mod+Shift+O, written as Meta on macOS.
    const taken = hotkeyRows(
      "trova",
      SUGGESTED_HOTKEYS,
      { "other:cmd": [hk(["Shift", "Meta"], "o")] },
      {},
      true,
    );
    expect(taken.map((r) => r.command)).toEqual(["ask"]);
    // The same default on Windows is Ctrl+Shift+O, so Mod+Shift+O is taken there too.
    const win = hotkeyRows(
      "trova",
      SUGGESTED_HOTKEYS,
      { "other:cmd": [hk(["Ctrl", "Shift"], "O")] },
      {},
      false,
    );
    expect(win.map((r) => r.command)).toEqual(["ask"]);
  });

  it("counts a default the user removed as free, and a custom hotkey as taken", () => {
    const defaults = { "other:cmd": [hk(["Mod", "Shift"], "O")] };
    expect(hotkeyRows("trova", SUGGESTED_HOTKEYS, defaults, { "other:cmd": [] }, true).length).toBe(
      2,
    );
    const custom = { "other:cmd": [hk(["Mod", "Shift"], "A")] };
    expect(hotkeyRows("trova", SUGGESTED_HOTKEYS, {}, custom, true).map((r) => r.command)).toEqual([
      "instant-search",
    ]);
  });

  it("shows a Trova command's own hotkey instead of the suggestion", () => {
    const rows = hotkeyRows(
      "trova",
      SUGGESTED_HOTKEYS,
      {},
      { "trova:ask": [hk(["Mod"], "J")] },
      true,
    );
    expect(rows.find((r) => r.command === "ask")).toMatchObject({
      assigned: true,
      hotkey: { key: "J" },
    });
  });

  it("writes keys as each platform does, in its usual order", () => {
    expect(hotkeyKeys(hk(["Shift", "Mod"], "o"), true)).toEqual(["⇧", "⌘", "O"]);
    expect(hotkeyKeys(hk(["Mod", "Alt", "Ctrl"], "k"), true)).toEqual(["⌃", "⌥", "⌘", "K"]);
    expect(hotkeyKeys(hk(["Shift", "Mod"], "o"), false)).toEqual(["Ctrl", "Shift", "O"]);
    expect(hotkeyId(hk(["Mod", "Shift"], "o"), true)).toBe(
      hotkeyId(hk(["Shift", "Meta"], "O"), true),
    );
  });
});
