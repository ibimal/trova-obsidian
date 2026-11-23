// The hotkeys the first-index notice suggests. A suggestion never takes a combination that another
// command uses, whether Obsidian's own, another plugin's or one the user set, and never one the
// operating system reserves.

import type { Hotkey, Modifier } from "obsidian";
import type { StringKey } from "./i18n/en.js";

export interface HotkeySuggestion {
  /** The command's id without the plugin prefix, as registered with addCommand. */
  command: string;
  /** The command's name, as a string key. */
  label: StringKey;
  hotkey: Hotkey;
}

/**
 * The suggestions. Mod+Shift with a letter is free in Obsidian's defaults and reserved by no
 * operating system for O or A. Mod+Alt combinations are avoided: Ctrl+Alt is AltGr on many
 * Windows and Linux keyboard layouts, and Obsidian already uses several.
 */
export const SUGGESTED_HOTKEYS: HotkeySuggestion[] = [
  {
    command: "instant-search",
    label: "cmdInstant",
    hotkey: { modifiers: ["Mod", "Shift"], key: "O" },
  },
  { command: "ask", label: "cmdAsk", hotkey: { modifiers: ["Mod", "Shift"], key: "A" } },
];

/** One row of the notice: a command and the hotkey to show for it. */
export interface HotkeyRow {
  command: string;
  label: StringKey;
  hotkey: Hotkey;
  /** True when the command already has this hotkey; false when it is a suggestion. */
  assigned: boolean;
}

/** A hotkey as a comparable string, independent of modifier order and letter case. */
export function hotkeyId(h: Hotkey, isMac: boolean): string {
  // On macOS, Mod is Meta; elsewhere it is Ctrl.
  const mods = h.modifiers.map((m) => (m === "Mod" ? (isMac ? "Meta" : "Ctrl") : m));
  return [...new Set(mods)].sort().join("+") + "+" + h.key.toUpperCase();
}

/**
 * The rows to show. A command that already has a hotkey shows its own. Otherwise its suggestion
 * shows only when no command uses that combination. Hotkeys in effect are each command's custom
 * ones when set, else its defaults.
 */
export function hotkeyRows(
  pluginId: string,
  suggestions: HotkeySuggestion[],
  defaults: Record<string, Hotkey[]>,
  custom: Record<string, Hotkey[]>,
  isMac: boolean,
): HotkeyRow[] {
  const inEffect = (id: string) => custom[id] ?? defaults[id] ?? [];
  const taken = new Set<string>();
  for (const id of new Set([...Object.keys(defaults), ...Object.keys(custom)]))
    for (const h of inEffect(id)) taken.add(hotkeyId(h, isMac));
  const rows: HotkeyRow[] = [];
  for (const s of suggestions) {
    const own = inEffect(`${pluginId}:${s.command}`)[0];
    if (own) rows.push({ command: s.command, label: s.label, hotkey: own, assigned: true });
    else if (!taken.has(hotkeyId(s.hotkey, isMac)))
      rows.push({ command: s.command, label: s.label, hotkey: s.hotkey, assigned: false });
  }
  return rows;
}

/**
 * The keys of a hotkey as this platform writes them, in its usual modifier order: ⌃ ⌥ ⇧ ⌘ on
 * macOS, Ctrl, Win, Alt, Shift elsewhere.
 */
export function hotkeyKeys(h: Hotkey, isMac: boolean): string[] {
  const resolved = h.modifiers.map((m) => (m === "Mod" ? (isMac ? "Meta" : "Ctrl") : m));
  const order: Modifier[] = isMac
    ? ["Ctrl", "Alt", "Shift", "Meta"]
    : ["Ctrl", "Meta", "Alt", "Shift"];
  const names: Record<string, string> = isMac
    ? { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" }
    : { Ctrl: "Ctrl", Meta: "Win", Alt: "Alt", Shift: "Shift" };
  const mods = [...new Set(resolved)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...mods.map((m) => names[m] ?? m), h.key.length === 1 ? h.key.toUpperCase() : h.key];
}
