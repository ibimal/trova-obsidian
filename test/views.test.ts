import { describe, expect, it } from "vitest";
import { BasketView } from "../src/views/BasketView.js";
import { ConnectionsView } from "../src/views/ConnectionsView.js";
import { GraphView } from "../src/views/GraphView.js";
import { TopicMapView } from "../src/views/TopicMapView.js";
import { VaultCareView } from "../src/views/VaultCareView.js";

// Obsidian calls these members of View and Component itself. Several, such as `open(containerEl)`,
// are missing from the public typings, so the compiler cannot catch a subclass that replaces one.
// A view that defines one of them opens as a blank tab. The view-state methods are public API that
// views override on purpose; the second test checks that those overrides keep the base state.
const RESERVED = ["open", "close", "load", "unload", "onload", "onunload", "onResize", "onPaneMenu", "onHeaderMenu", "addAction", "addChild", "removeChild", "register", "registerEvent", "registerDomEvent", "registerInterval", "handleDrop", "handleCopy", "handlePaste"];

describe("views", () => {
  it.each([BasketView, ConnectionsView, GraphView, TopicMapView, VaultCareView].map((v) => [v.name, v] as const))("%s does not replace a member Obsidian calls", (_name, view) => {
    const own = Object.getOwnPropertyNames(view.prototype);
    expect(own.filter((name) => RESERVED.includes(name))).toEqual([]);
  });

  it.each([GraphView, VaultCareView].map((v) => [v.name, v] as const))("%s keeps the base view state and ignores bad stored state", async (_name, View) => {
    const view = new View({} as never, {} as never);
    expect(view.getState()).toMatchObject({ base: true });
    expect(view.getEphemeralState()).toMatchObject({ base: true });
    for (const bad of [null, "junk", 42, { group: "nope", path: 7, limit: 13, locked: "yes" }]) {
      await expect(view.setState(bad, { history: false })).resolves.toBeUndefined();
      view.setEphemeralState(bad);
    }
    expect(view.getState()).not.toMatchObject({ group: "nope" });
  });
});
