// The plugin calls window.setTimeout and friends, as Obsidian recommends. Under Node, point
// window at the global object, so the code runs and Vitest's fake timers still apply.
(globalThis as { window?: unknown }).window ??= globalThis;
