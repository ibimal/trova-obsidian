// A minimal stand-in for the `obsidian` module, enough to load the plugin's modules in tests.

export class Component {
  register(): void {}
  registerEvent(): void {}
  registerDomEvent(): void {}
  load(): void {}
  unload(): void {}
}
export class Plugin extends Component {
  app: unknown;
  manifest = { version: "0.0.0", id: "trova" };
  constructor(app?: unknown) {
    super();
    this.app = app;
  }
}
export class Modal {
  constructor(public app: unknown) {}
  open(): void {}
  close(): void {}
}
export class ItemView extends Component {
  constructor(public leaf: unknown) {
    super();
  }
  getState(): Record<string, unknown> {
    return { base: true };
  }
  async setState(): Promise<void> {}
  getEphemeralState(): Record<string, unknown> {
    return { base: true };
  }
  setEphemeralState(): void {}
}
export class MarkdownView extends ItemView {}
export class MarkdownRenderChild extends Component {
  constructor(public containerEl: unknown) {
    super();
  }
}
export class PluginSettingTab {
  constructor(
    public app: unknown,
    public plugin: unknown,
  ) {}
}
export class EditorSuggest<T> {
  context: unknown = null;
  constructor(public app: unknown) {}
  declare _t: T;
}
export class Setting {}
export const Keymap = {
  isModifier: (e: { metaKey?: boolean }, mod: string) => mod === "Mod" && !!e.metaKey,
  isModEvent: (e?: { metaKey?: boolean; altKey?: boolean; shiftKey?: boolean } | null) =>
    !e?.metaKey ? false : !e.altKey ? "tab" : e.shiftKey ? "window" : "split",
};
export class Menu {}
export class Notice {
  constructor(public message?: string) {}
  hide(): void {}
}
export class TFile {
  path = "";
  extension = "md";
  basename = "";
  stat = { ctime: 0, mtime: 0, size: 0 };
}
export const Platform = { isDesktopApp: true, isMobile: false, isMacOS: true };
export const editorInfoField = {};
export function setIcon(): void {}
export function debounce<T extends (...a: never[]) => unknown>(fn: T): T {
  return fn;
}
export function getAllTags(): string[] {
  return [];
}
export function parseFrontMatterAliases(): string[] {
  return [];
}
