// Trova: lifecycle, command and view registration. `onload` registers and returns; the worker,
// the engine connection and indexing start inside workspace.onLayoutReady.

import { MarkdownView, Modal, Notice, Platform, Plugin, TFile, type Editor, type WorkspaceLeaf } from "obsidian";
import {
  findBlock,
  parseId,
  queryRanges,
  sourceId,
  splitBlocks,
  vaultCollectionName,
  parseQuery,
  type CollectionAddRequest,
  type ContextFormat,
  type Result,
} from "@trova/contract";
import workerCode from "virtual:worker-code";
import { BadgeStore, badgeExtension, badgePostProcessor } from "./editor/badges.js";
import { footerExtension } from "./editor/footer.js";
import { LinkSuggest } from "./editor/linkSuggest.js";
import { findBinary, readDaemonInfo, spawnDaemon } from "./engine/launcher.js";
import { EngineManager } from "./engine/manager.js";
import { createApi, type TrovaApi } from "./features/api.js";
import { registerBases } from "./features/bases.js";
import { Basket } from "./features/basket.js";
import { ConnectionsService, type Anchor } from "./features/connections.js";
import { HttpApi } from "./features/httpApi.js";
import { savedSearchProcessor } from "./features/savedSearch.js";
import { t } from "./i18n/en.js";
import { VaultIndexer, idle } from "./indexer.js";
import { QueryController, type ControllerDeps } from "./query/controller.js";
import type { TrovaSettings } from "./settings.js";
import { TrovaSettingTab } from "./settingsTab.js";
import { DataStore, LocalState } from "./state/store.js";
import { linkFor, openTarget, type OpenIn, type OpenTarget } from "./ui.js";
import { BASKET_VIEW, BasketView } from "./views/BasketView.js";
import { CONNECTIONS_VIEW, ConnectionsView, resultHeading, resultHeadingPath, sectionAt } from "./views/ConnectionsView.js";
import { GRAPH_VIEW, GraphView } from "./views/GraphView.js";
import { InstantModal } from "./views/InstantModal.js";
import { OnboardingModal } from "./views/Onboarding.js";
import { StatusBar } from "./views/StatusBar.js";
import { TOPIC_VIEW, TopicMapView } from "./views/TopicMapView.js";
import { CARE_VIEW, VaultCareView, type CareGroup } from "./views/VaultCareView.js";
import { startInline, startWorker, type WorkerHost } from "./worker/host.js";

class PromptModal extends Modal {
  constructor(
    plugin: TrovaPlugin,
    private label: string,
    private initial: string,
    private done: (value: string) => void,
  ) {
    super(plugin.app);
  }
  override onOpen(): void {
    this.titleEl.setText(this.label);
    const input = this.contentEl.createEl("input", { type: "text", value: this.initial, cls: "trova-prompt" });
    const submit = () => {
      this.close();
      this.done(input.value);
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: t("confirm"), cls: "mod-cta" }).addEventListener("click", submit);
    input.focus();
    input.select();
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}

export default class TrovaPlugin extends Plugin {
  store!: DataStore;
  local!: LocalState;
  engine!: EngineManager;
  worker!: WorkerHost;
  indexer!: VaultIndexer;
  controller!: QueryController;
  connections!: ConnectionsService;
  basket!: Basket;
  api!: TrovaApi;
  collection = "vault";
  /** Set by the welcome screen: the next finished index reports its totals once. */
  announceFinish = false;
  readonly isDesktop = Platform.isDesktopApp;
  private statusBar: StatusBar | null = null;
  private badges!: BadgeStore;
  private httpApi: HttpApi | null = null;
  private frontmatterKeys = new Set<string>();
  private ocrRunning = false;

  /** The same object as `store.settings`; the store mutates it in place. */
  declare settings: TrovaSettings;

  override async onload(): Promise<void> {
    this.store = new DataStore({ load: () => this.loadData(), save: (data) => this.saveData(data), backup: () => this.backupData() });
    await this.store.load();
    if (this.store.backupName) new Notice(t("dataRepaired", { file: this.store.backupName }), 12_000);
    else if (this.store.loadFailed) new Notice(t("dataUnreadable"), 12_000);
    this.settings = this.store.settings;
    this.local = new LocalState({ load: (key) => this.app.loadLocalStorage(key) as unknown, save: (key, value) => this.app.saveLocalStorage(key, value) });
    this.basket = new Basket(this.app, this.local);
    // The worker starts in onLayoutReady; until then calls run on a small inline index.
    this.worker = startInline();
    this.engine = new EngineManager({
      desktop: this.isDesktop,
      mode: () => this.settings.engineMode,
      endpoint: () => {
        if (this.settings.engineMode === "external") {
          return this.settings.engineAddress ? { base: this.settings.engineAddress.replace(/\/+$/, ""), token: this.settings.engineToken, api: "" } : null;
        }
        const info = readDaemonInfo();
        return info ? { base: `http://127.0.0.1:${info.port}`, token: info.token, api: info.api } : null;
      },
      findBinary: () => findBinary(this.settings.engineBinaryPath),
      spawn: (binary) => spawnDaemon(binary, this.settings.debugLog, this.settings.embeddingModel, this.settings.gpu),
      collections: () => this.collectionRequests(),
      mayIndex: () => this.local.onboarded && this.local.get<boolean>("no-engine") !== true,
      log: (message) => this.settings.debugLog && console.debug(`[trova] ${message}`),
    });
    this.indexer = new VaultIndexer({
      app: this.app,
      worker: new Proxy({} as WorkerHost, { get: (_t, prop) => (this.worker as unknown as Record<string | symbol, unknown>)[prop] }),
      scope: () => ({ include: this.settings.includeGlobs, exclude: this.settings.excludeGlobs }),
      engineIndexes: () => this.engine.ready,
      onChange: (change) => this.engine.queueSync(change),
      onProgress: () => this.statusBar?.update(),
    });
    this.controller = new QueryController(this.controllerDeps());
    this.connections = new ConnectionsService({
      app: this.app,
      engine: this.engine,
      store: this.store,
      settings: () => this.settings,
      isExcluded: (path) => this.indexer.isExcluded(path, this.fileCache(path)),
    });
    this.api = createApi(this);
    this.badges = new BadgeStore(this);

    this.registerView(CONNECTIONS_VIEW, (leaf) => new ConnectionsView(leaf, this));
    this.registerView(BASKET_VIEW, (leaf) => new BasketView(leaf, this));
    this.registerView(CARE_VIEW, (leaf) => new VaultCareView(leaf, this));
    this.registerView(TOPIC_VIEW, (leaf) => new TopicMapView(leaf, this));
    this.registerView(GRAPH_VIEW, (leaf) => new GraphView(leaf, this));
    this.registerHoverLinkSource(CONNECTIONS_VIEW, { display: t("connectionsTitle"), defaultMod: true });
    this.addSettingTab(new TrovaSettingTab(this.app, this));
    this.addRibbonIcon("search", `${t("name")}: ${t("cmdInstant")}`, () => new InstantModal(this).open());
    this.statusBar = new StatusBar(this, this.addStatusBarItem());
    this.registerCommands();
    this.registerMenus();

    this.registerMarkdownCodeBlockProcessor("trova", savedSearchProcessor(this));
    this.registerMarkdownPostProcessor(badgePostProcessor(this, this.badges));
    this.registerEditorExtension([badgeExtension(this, this.badges), footerExtension(this)]);
    const suggest = new LinkSuggest(this);
    this.registerEditorSuggest(suggest);
    // Obsidian asks suggesters in order; ours must come before the built-in `[[` suggester.
    const suggests = (this.app.workspace as unknown as { editorSuggest?: { suggests?: unknown[] } }).editorSuggest?.suggests;
    if (Array.isArray(suggests) && suggests.includes(suggest)) {
      suggests.splice(suggests.indexOf(suggest), 1);
      suggests.unshift(suggest);
    }
    this.registerObsidianProtocolHandler("trova", (params) => {
      const q = params["q"] ?? "";
      if (params["mode"] === "ask") void this.openAsk(q);
      else new InstantModal(this, { query: q }).open();
    });
    registerBases(this);

    this.register(this.engine.onChange(() => this.statusBar?.update()));
    this.register(this.engine.onEvent((e) => this.onEngineEvent(e.event, e.data)));
    this.registerVaultEvents();
    this.app.workspace.onLayoutReady(() => void this.startBackground());
  }

  override onunload(): void {
    // Abort all requests, close the event stream and terminate the worker. The daemon keeps running.
    this.controller.cancel();
    this.indexer.stop();
    this.engine.stop();
    this.worker.terminate();
    this.httpApi?.stop();
    this.statusBar?.close();
    void this.store.flush();
    document.querySelectorAll(".trova-popover").forEach((el) => el.remove());
  }

  private async startBackground(): Promise<void> {
    const basePath = (this.app.vault.adapter as unknown as { getBasePath?: () => string }).getBasePath?.();
    this.collection = await vaultCollectionName(basePath ?? `mobile:${this.app.vault.getName()}`);
    this.engine.vaultCollection = this.collection;
    try {
      this.worker = startWorker(workerCode);
    } catch {
      this.worker = startInline();
    }
    void this.indexer.start().then(() => this.collectFrontmatterKeys());
    if (this.local.get<boolean>("no-engine") === true || !this.isDesktop) this.engine.disable();
    else this.engine.start();
    if (this.isDesktop && !this.local.onboarded) new OnboardingModal(this).open();
    this.applySettings("http");
    this.watchBattery();
    const active = this.app.workspace.getActiveFile();
    if (active) this.local.markOpened(active.path);
  }

  // ---------- wiring ----------

  controllerDeps(): ControllerDeps {
    return {
      worker: { call: (method, args, signal) => this.worker.call(method, args, signal) },
      engine: this.engine,
      vaultCollection: () => this.collection,
      collections: () => this.engine.collections(),
      settings: () => this.settings,
      daysSinceOpened: (path) => this.local.daysSinceOpened(path),
      knownKeys: () => this.knownKeys(),
    };
  }

  private async collectionRequests(): Promise<CollectionAddRequest[]> {
    const basePath = (this.app.vault.adapter as unknown as { getBasePath?: () => string }).getBasePath?.() ?? "";
    const attachments = this.settings.attachmentTypes.map((a) => a.toLowerCase());
    const out: CollectionAddRequest[] = [
      {
        name: this.collection,
        path: basePath,
        options: { kind: "vault", include: this.settings.includeGlobs, exclude: this.indexer.excludeGlobs(), attachments },
        context: this.store.data.folderContext,
      },
    ];
    for (const f of this.settings.outsideFolders) out.push({ name: f.name, path: f.path, options: { kind: "folder", attachments: attachments.filter((a) => a !== "image") } });
    return out;
  }

  /** Applies a settings change without a restart. */
  applySettings(effect: "none" | "scope" | "engine" | "editor" | "http" | "debug" | "connections"): void {
    if (effect === "scope") {
      this.indexer.refreshScope();
      void this.indexer.reindexAll();
      this.connections.clear();
      void this.engine.reregister();
    } else if (effect === "engine") {
      if (!this.engine.ready && this.engineWanted()) void this.engine.connect(true);
      else void this.engine.reregister();
      if (this.engine.ready) void this.engine.setPaused(!this.settings.backgroundIndexing).catch(() => undefined);
    } else if (effect === "editor") {
      this.badges.invalidate();
      this.app.workspace.updateOptions();
    } else if (effect === "connections") {
      this.connections.clear();
    } else if (effect === "debug") {
      this.engine.setDebug(this.settings.debugLog);
    } else if (effect === "http" && this.isDesktop) {
      this.httpApi?.stop();
      this.httpApi = null;
      if (this.settings.httpApi) {
        if (!this.settings.httpApiToken) this.store.updateSettings({ httpApiToken: this.newToken() });
        this.httpApi = new HttpApi(this);
        this.httpApi.start(this.settings.httpApiPort, this.settings.httpApiToken).then(
          () => new Notice(t("httpApiOn", { port: this.settings.httpApiPort })),
          (err: Error) => new Notice(`${t("name")}: ${err.message}`),
        );
      }
    }
    this.statusBar?.update();
  }

  newToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  private watchBattery(): void {
    const nav = navigator as unknown as { getBattery?: () => Promise<{ charging: boolean; addEventListener(e: string, cb: () => void): void }> };
    void nav.getBattery?.().then((battery) => {
      const apply = () => {
        if (this.settings.pauseOnBattery && this.engine.ready) void this.engine.setPaused(!battery.charging || !this.settings.backgroundIndexing).catch(() => undefined);
      };
      battery.addEventListener("chargingchange", apply);
      apply();
    });
  }

  private registerVaultEvents(): void {
    const { vault, metadataCache, workspace } = this.app;
    const ready = () => workspace.layoutReady;
    this.registerEvent(vault.on("create", (f) => ready() && f instanceof TFile && void this.indexer.onModify(f)));
    this.registerEvent(
      vault.on("modify", (f) => {
        if (!(f instanceof TFile)) return;
        void this.indexer.onModify(f);
        this.connections.markStale([this.sourceId(f.path)]);
        this.badges.invalidate(f.path);
      }),
    );
    this.registerEvent(
      vault.on("delete", (f) => {
        if (!(f instanceof TFile)) return;
        void this.indexer.onDelete(f.path);
        this.store.removeSource(this.sourceId(f.path));
        this.connections.dropPath(f.path);
      }),
    );
    this.registerEvent(
      vault.on("rename", (f, oldPath) => {
        if (!(f instanceof TFile)) return;
        void this.indexer.onRename(f, oldPath);
        // Pins and hides survive renames: ids are rewritten here and the engine keeps its vectors.
        this.store.renameSource(this.sourceId(oldPath), this.sourceId(f.path));
        this.local.renameOpened(oldPath, f.path);
        this.connections.dropPath(oldPath);
        this.basket.setAll(this.basket.items.map((i) => (i.path === oldPath ? { ...i, path: f.path, key: i.key.replace(oldPath, f.path), title: f.basename } : i)));
      }),
    );
    this.registerEvent(metadataCache.on("changed", (f, data) => void this.indexer.onCacheChanged(f, data)));
    this.registerEvent(workspace.on("file-open", (f) => f && this.local.markOpened(f.path)));
    let editTimer: number | null = null;
    this.registerEvent(
      workspace.on("editor-change", (editor, info) => {
        this.indexer.noteTyping();
        const file = info.file;
        if (!file || file.extension !== "md") return;
        // A pause of 250 ms in typing sends the editor's text to the worker's overlay.
        if (editTimer !== null) window.clearTimeout(editTimer);
        editTimer = window.setTimeout(() => {
          editTimer = null;
          void this.indexer.onEditorText(file.path, editor.getValue());
        }, 250);
      }),
    );
    this.register(() => editTimer !== null && window.clearTimeout(editTimer));
  }

  private onEngineEvent(event: string, data: Record<string, unknown>): void {
    if (event === "results.stale") {
      const sources = (data["sources"] as string[] | undefined) ?? [];
      // The engine has indexed these sources, so they leave the worker's overlay.
      const paths = sources.map((s) => parseId(s)).filter((p) => p?.collection === this.collection).map((p) => p!.path);
      if (paths.length) void this.worker.clearDirty(paths);
      this.connections.markStale(sources);
    } else if (event === "index.ready") {
      void this.worker.clearDirty();
      this.connections.clear();
      this.badges.invalidate();
      void this.collectFrontmatterKeys();
      void this.pushOcrText();
      if (this.announceFinish) {
        this.announceFinish = false;
        void this.engine.refreshStatus().then((status) => {
          const c = status?.collections.find((x) => x.name === this.collection);
          const notice = new Notice("", 15000);
          const el = notice.messageEl ?? (notice as unknown as { noticeEl: HTMLElement }).noticeEl;
          el.createDiv({ text: t("finishNotice", { sources: (c?.sources ?? 0).toLocaleString(), embedded: (c?.embedded ?? 0).toLocaleString() }) });
          el.createDiv({ cls: "trova-row-path", text: t("hotkeysHint") });
          el.createEl("button", { text: t("setHotkeys") }).addEventListener("click", () => this.openSettings("hotkeys"));
        });
      }
    }
    this.statusBar?.update();
  }

  private async collectFrontmatterKeys(): Promise<void> {
    const keys = new Set<string>();
    if (this.engine.ready) {
      const res = await this.engine.metadataKeys().catch(() => null);
      for (const k of Object.keys(res?.keys ?? {})) keys.add(k);
    }
    const files = this.app.vault.getMarkdownFiles();
    for (let i = 0; i < files.length; i++) {
      if (i % 500 === 499) await idle();
      for (const k of Object.keys(this.app.metadataCache.getFileCache(files[i]!)?.frontmatter ?? {})) keys.add(k.toLowerCase());
    }
    keys.delete("position");
    this.frontmatterKeys = keys;
  }

  /** Image OCR comes from the Text Extractor plugin, when it is installed. The engine stores the text. */
  private async pushOcrText(): Promise<void> {
    if (this.ocrRunning || !this.engine.ready || !this.settings.attachmentTypes.includes("image")) return;
    const extractor = (this.app as unknown as { plugins: { plugins: Record<string, { api?: { extractText(file: TFile): Promise<string>; canFileBeExtracted?(path: string): boolean } }> } }).plugins.plugins["text-extractor"]?.api;
    if (!extractor) return;
    this.ocrRunning = true;
    try {
      const stored = this.local.get<unknown>("ocr");
      const pushed: Record<string, number> = {};
      if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
        for (const [path, at] of Object.entries(stored)) if (typeof at === "number") pushed[path] = at;
      }
      const images = this.app.vault.getFiles().filter((f) => /^(png|jpe?g|webp|gif|bmp)$/i.test(f.extension) && !this.indexer.isExcluded(f.path));
      for (const file of images) {
        if (!this.engine.ready) break;
        if (pushed[file.path] === file.stat.mtime) continue;
        await idle();
        const text = await extractor.extractText(file).catch(() => "");
        await this.engine.pushAttachmentText(file.path, text).catch(() => undefined);
        pushed[file.path] = file.stat.mtime;
        this.local.set("ocr", pushed);
      }
    } finally {
      this.ocrRunning = false;
    }
  }

  // ---------- helpers used by the views ----------

  private fileCache(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? this.app.metadataCache.getFileCache(file) : null;
  }

  sourceId(path: string): string {
    return sourceId(this.collection, path);
  }

  /** The absolute folder of an outside collection; undefined for the vault. */
  rootOf(collection: string): string | undefined {
    if (!collection || collection === this.collection) return undefined;
    return this.settings.outsideFolders.find((f) => f.name === collection)?.path;
  }

  engineWanted(): boolean {
    return this.isDesktop && this.local.get<boolean>("no-engine") !== true;
  }

  knownKeys(): ReadonlySet<string> | undefined {
    return this.frontmatterKeys.size > 0 ? this.frontmatterKeys : undefined;
  }

  /** How much of the vault is searchable: the worker's body pass, and the engine's index when it runs. */
  indexedPercent(): number {
    const p = this.indexer.progress;
    let pct = p.running && p.total > 0 ? Math.floor((p.done / p.total) * 100) : 100;
    const c = this.engine.ready ? this.engine.snapshot.status?.collections.find((x) => x.name === this.collection) : undefined;
    if (c && c.sources > 0 && c.embedded < c.sources && this.engine.snapshot.status!.jobs.length > 0) pct = Math.min(pct, Math.floor((c.embedded / c.sources) * 100));
    return pct;
  }

  bookmarkedPaths(): string[] {
    const items = (this.app as unknown as { internalPlugins?: { plugins?: Record<string, { instance?: { items?: { type: string; path?: string; items?: unknown[] }[] } }> } }).internalPlugins?.plugins?.["bookmarks"]?.instance?.items ?? [];
    const out: string[] = [];
    const walk = (list: { type: string; path?: string; items?: unknown[] }[]) => {
      for (const item of list) {
        if (item.type === "file" && item.path) out.push(item.path);
        else if (item.type === "group" && Array.isArray(item.items)) walk(item.items as typeof list);
      }
    };
    walk(items);
    return out.slice(0, 12);
  }

  dailyFolder(): string | null {
    const options = (this.app as unknown as { internalPlugins?: { plugins?: Record<string, { enabled?: boolean; instance?: { options?: { folder?: string } } }> } }).internalPlugins?.plugins;
    const folder = options?.["daily-notes"]?.enabled ? options["daily-notes"]!.instance?.options?.folder : undefined;
    return folder ? folder.replace(/^\/+|\/+$/g, "") : null;
  }

  private templatesFolder(): string | null {
    const options = (this.app as unknown as { internalPlugins?: { plugins?: Record<string, { enabled?: boolean; instance?: { options?: { folder?: string } } }> } }).internalPlugins?.plugins;
    const folder = options?.["templates"]?.enabled ? options["templates"]!.instance?.options?.folder : undefined;
    return folder ? folder.replace(/^\/+|\/+$/g, "") : null;
  }

  /** Daily notes, templates and the folders from the settings are left out of orphans and Rediscover. */
  isCareExcluded(path: string): boolean {
    const folders = [this.dailyFolder(), this.templatesFolder(), ...this.settings.careExcludedFolders].filter((f): f is string => !!f);
    return folders.some((f) => path === f || path.startsWith(`${f.replace(/\/+$/, "")}/`)) || this.indexer.isExcluded(path, this.fileCache(path));
  }

  open(target: OpenTarget, where: OpenIn = false): Promise<void> {
    return openTarget(this.app, target, where);
  }

  /** Opens a result at its matched block. With a query, the first match in the block is flashed. */
  async openResult(r: Result, where: OpenIn = false, query?: string): Promise<void> {
    const root = this.rootOf(r.collection ?? "");
    let offset = r.block?.start;
    let length: number | undefined;
    const file = root ? null : this.app.vault.getAbstractFileByPath(r.path);
    if (file instanceof TFile && file.extension === "md" && (query || r.highlights.length)) {
      const content = await this.app.vault.cachedRead(file);
      const start = r.block?.start ?? 0;
      const end = r.block?.end ?? content.length;
      let hit: [number, number] | undefined;
      if (query) hit = queryRanges(content, parseQuery(query, { mode: "ask" }).query).find((x) => x[0] >= start && x[1] <= end);
      if (!hit && r.highlights[0]) {
        // Find the highlighted text of the snippet inside the block.
        const word = r.snippet.slice(r.highlights[0][0], r.highlights[0][1]);
        const at = word ? content.indexOf(word, start) : -1;
        if (at !== -1 && at < end) hit = [at, at + word.length];
      }
      if (hit) {
        offset = hit[0];
        length = hit[1] - hit[0];
      }
    }
    await this.open({ path: r.path, root, headings: r.block?.headings, offset, length }, where);
  }

  async openById(id: string, where: OpenIn = false): Promise<void> {
    const target = await this.targetFor(id);
    if (target) await this.open(target, where);
  }

  /**
   * Compare: opens a note in a vertical split beside another pane, so the two show side by side
   * and no tab is replaced. `beside` is the pane to split; by default the pane that shows
   * `besidePath`, else the most recent pane in the main area. With `reuse`, a pane that already
   * shows the note is focused instead of a new split. With `own`, a section shown in that pane, the
   * pane also scrolls to it and marks it, so both sides of a section pair are in view.
   */
  async openBeside(id: string, opts: { beside?: WorkspaceLeaf; besidePath?: string; reuse?: boolean; own?: string } = {}): Promise<WorkspaceLeaf | null> {
    const target = await this.targetFor(id);
    if (!target) return null;
    const { workspace } = this.app;
    const main = (leaf: WorkspaceLeaf) => leaf.getRoot() === workspace.rootSplit;
    const showing = (path: string) => workspace.getLeavesOfType("markdown").filter((l) => main(l) && (l.view as MarkdownView).file?.path === path);
    const base = opts.beside ?? (opts.besidePath ? showing(opts.besidePath)[0] : undefined) ?? workspace.getMostRecentLeaf(workspace.rootSplit) ?? undefined;
    if (target.root) {
      await this.open(target, true);
      return null;
    }
    if (opts.own && base && parseId(opts.own)?.headingPath !== undefined) {
      const own = await this.targetFor(opts.own);
      if (own && !own.root && (base.view as MarkdownView).file?.path === own.path) await openTarget(this.app, own, false, base);
    }
    const existing = opts.reuse ? showing(target.path).find((l) => l !== base) : undefined;
    const leaf = existing ?? (base ? workspace.createLeafBySplit(base, "vertical") : workspace.getLeaf("split", "vertical"));
    await openTarget(this.app, target, false, leaf);
    workspace.setActiveLeaf(leaf, { focus: true });
    return leaf;
  }

  /** Opens two notes side by side in a new pair of panes, leaving the current tab as it is. */
  async compare(aId: string, bId: string): Promise<void> {
    const target = await this.targetFor(aId);
    if (!target) return;
    const left = this.app.workspace.getLeaf("tab");
    await openTarget(this.app, target, false, left);
    await this.openBeside(bId, { beside: left });
  }

  /**
   * Where a source or block id opens: its file and, for a block, its heading and its exact range,
   * so the block is scrolled to and marked from its heading to the next heading of any level. A
   * heading link would mark everything nested under the heading, which can be the whole note.
   */
  private async targetFor(id: string): Promise<OpenTarget | null> {
    const parsed = parseId(id);
    if (!parsed) return null;
    const target: OpenTarget = { path: parsed.path, root: this.rootOf(parsed.collection) };
    const file = this.app.vault.getAbstractFileByPath(parsed.path);
    if (!target.root && parsed.headingPath !== undefined && file instanceof TFile && file.extension === "md") {
      const content = await this.app.vault.cachedRead(file);
      const block = findBlock(splitBlocks(content), parsed.headingPath);
      if (block) {
        target.headings = block.headings;
        target.offset = block.start;
        // The range ends at the block's last character, so the trailing blank lines are not marked.
        const length = content.slice(block.start, block.end).trimEnd().length;
        if (length > 0) target.length = length;
      }
    }
    return target;
  }

  linkText(r: Result): string {
    return linkFor(this.app, r.path, resultHeading(r), this.app.workspace.getActiveFile()?.path ?? "");
  }

  private recentEditor(): Editor | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) return active.editor;
    const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
    return leaf?.view instanceof MarkdownView ? leaf.view.editor : null;
  }

  insertLink(r: Result): void {
    const editor = this.recentEditor();
    if (!editor) return void new Notice(t("noEditor"));
    editor.replaceSelection(this.linkText(r));
    new Notice(t("linkInserted"));
  }

  addResultToBasket(r: Result, neighbours = false): void {
    if (r.collection && r.collection !== this.collection) return;
    const headingPath = resultHeadingPath(r);
    const block = r.block && headingPath !== undefined ? { headingPath, headings: r.block.headings } : undefined;
    new Notice(this.basket.add(r.path, block, neighbours && !!block) ? t("addedToBasket") : t("alreadyInBasket"));
  }

  /** Copies the basket, or saves it as a note. The button shows progress and the editor stays usable. */
  async copyBasket(format: ContextFormat, button?: HTMLButtonElement): Promise<void> {
    if (this.basket.items.length === 0) return void new Notice(t("basketEmpty"));
    const label = button?.textContent ?? "";
    if (button) button.disabled = true;
    try {
      const { text, tokens } = await this.basket.assemble(format, (done, total) => button?.setText(t("copying", { done, total })));
      if (format === "note") {
        const folder = this.settings.contextNoteFolder.replace(/^\/+|\/+$/g, "") || this.app.fileManager.getNewFileParent("").path.replace(/^\/$/, "");
        if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
        const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "");
        const path = `${folder ? `${folder}/` : ""}Context ${stamp}.md`;
        const file = await this.app.vault.create(path, text);
        new Notice(t("basketSaved", { path }));
        await this.app.workspace.getLeaf("tab").openFile(file);
      } else {
        await navigator.clipboard.writeText(text);
        new Notice(t("basketCopied", { n: tokens.toLocaleString() }));
      }
    } finally {
      if (button) {
        button.disabled = false;
        button.setText(label);
      }
    }
  }

  /**
   * Copies data.json next to itself as `data.backup-<time>.json`, before the store repairs it.
   * Returns the copy's file name, or null when there is no file or it cannot be copied.
   */
  private async backupData(): Promise<string | null> {
    const dir = this.manifest.dir;
    if (!dir) return null;
    const adapter = this.app.vault.adapter;
    const source = `${dir}/data.json`;
    if (!(await adapter.exists(source))) return null;
    const name = `data.backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    await adapter.write(`${dir}/${name}`, await adapter.read(source));
    return name;
  }

  openSettings(tab = "trova"): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(tab);
  }

  showWelcome(): void {
    this.local.set("no-engine", false);
    if (!this.engine.ready) void this.engine.connect(true);
    new OnboardingModal(this).open();
  }

  prompt(label: string, initial: string, done: (value: string) => void): void {
    new PromptModal(this, label, initial, done).open();
  }

  // ---------- views ----------

  /**
   * Shows a view: its open tab if there is one, else a new one in the right sidebar or in the
   * current tab of the main area, as Obsidian opens its own Graph view, so Back returns to the
   * note it replaced. `state` is applied to the view either way.
   */
  private async reveal<T>(type: string, side: "right" | "main", state?: Record<string, unknown>): Promise<T | null> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(type)[0] ?? null;
    if (!leaf) leaf = side === "right" ? workspace.getRightLeaf(false) : workspace.getLeaf(false);
    if (leaf && (state || leaf.view.getViewType() !== type)) await leaf.setViewState({ type, active: true, state });
    if (!leaf) return null;
    await workspace.revealLeaf(leaf);
    return leaf.view as unknown as T;
  }

  /** The Connections pane, which also holds Ask. */
  private connectionsPane(): Promise<ConnectionsView | null> {
    return this.reveal<ConnectionsView>(CONNECTIONS_VIEW, "right");
  }

  /** Opens Ask in the Connections pane: runs the question, or focuses the search box. */
  async openAsk(question?: string, opts: { label?: string } = {}): Promise<void> {
    const view = await this.connectionsPane();
    if (!view) return;
    if (question && question.trim()) view.runQuestion(question, { label: opts.label });
    else view.focusInput();
  }

  /** Opens Vault care in an editor tab, at one of its groups when given. */
  async openVaultCare(group?: CareGroup): Promise<void> {
    const view = await this.reveal<VaultCareView>(CARE_VIEW, "main");
    if (group) view?.focusGroup(group);
  }

  /** Opens the similarity graph, centred on a note when a path is given. */
  async openGraph(path?: string): Promise<void> {
    await this.reveal<GraphView>(GRAPH_VIEW, "main", path ? { path } : undefined);
  }

  async moreLikeThis(r: Result): Promise<void> {
    const view = await this.connectionsPane();
    view?.moreLike(r);
  }

  async askAboutAnchor(anchor: Anchor | null): Promise<void> {
    if (!anchor) return;
    if (anchor.kind === "selection") return this.openAsk(anchor.text.slice(0, 600));
    const file = this.app.vault.getAbstractFileByPath(anchor.path);
    if (!(file instanceof TFile)) return;
    const content = await this.app.vault.cachedRead(file);
    const block = anchor.kind === "block" ? findBlock(splitBlocks(content), anchor.headingPath) : undefined;
    const text = (block ? content.slice(block.start, block.end) : content).replace(/^---[\s\S]*?\n---\n/, "");
    // The anchor's text becomes a vector query, so the whole passage is the question. The pane
    // shows a readable name instead of the passage.
    const name = anchor.kind === "block" && anchor.headings.length ? anchor.headings.at(-1)! : file.basename;
    await this.openAsk(`vec: ${text.replace(/\s+/g, " ").replace(/"/g, "").slice(0, 600)}`, { label: t("aboutLabel", { name }) });
  }

  private selection(): { path: string; text: string } | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const text = view?.editor.getSelection().trim();
    if (!view?.file || !text) return null;
    return { path: view.file.path, text };
  }

  private registerCommands(): void {
    const add = (id: string, name: string, callback: () => void) => this.addCommand({ id, name, callback });
    add("instant-search", t("cmdInstant"), () => new InstantModal(this).open());
    this.addCommand({
      id: "in-file-search",
      name: t("cmdInFile"),
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) new InstantModal(this, { inFilePath: file.path, query: this.selection()?.text.split("\n")[0] ?? "" }).open();
        return true;
      },
    });
    add("ask", t("cmdAsk"), () => void this.openAsk());
    add("ask-selection", t("cmdAskSelection"), () => {
      const sel = this.selection();
      if (!sel) return void new Notice(t("noSelection"));
      void this.openAsk(sel.text.replace(/\s+/g, " ").slice(0, 600));
    });
    add("open-connections", t("cmdConnections"), () => void this.reveal(CONNECTIONS_VIEW, "right"));
    add("connections-selection", t("cmdConnectionsSelection"), () => {
      const sel = this.selection();
      if (!sel) return void new Notice(t("noSelection"));
      void this.reveal<ConnectionsView>(CONNECTIONS_VIEW, "right").then((view) => view?.showSelection(sel.path, sel.text));
    });
    add("random-connection", t("cmdRandom"), () => void this.randomStrong());
    add("open-basket", t("cmdBasket"), () => void this.reveal(BASKET_VIEW, "right"));
    add("copy-basket", t("cmdCopyBasket"), () => void this.copyBasket("markdown"));
    add("add-note-to-basket", t("cmdAddNoteToBasket"), () => {
      const file = this.app.workspace.getActiveFile();
      if (file) new Notice(this.basket.add(file.path) ? t("addedToBasket") : t("alreadyInBasket"));
    });
    add("add-block-to-basket", t("cmdAddBlockToBasket"), () => this.addCursorBlockToBasket());
    add("vault-care", t("cmdVaultCare"), () => void this.openVaultCare());
    add("rediscover", t("cmdRediscover"), () => void this.openVaultCare("rediscover"));
    add("topic-map", t("cmdTopicMap"), () => void this.reveal(TOPIC_VIEW, "main"));
    add("similarity-graph", t("cmdGraph"), () => void this.openGraph(this.app.workspace.getActiveFile()?.path));
    add("reindex", t("cmdReindex"), () => {
      void this.indexer.reindexAll();
      for (const c of this.engine.collections()) this.engine.queueSync({ full: true }, c);
    });
    add("pause-indexing", t("cmdPause"), () => {
      if (this.engine.ready) void this.engine.setPaused(!this.engine.snapshot.status?.paused);
    });
    add("welcome", t("cmdWelcome"), () => this.showWelcome());
  }

  private addCursorBlockToBasket(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) return void new Notice(t("noEditor"));
    const headings = (this.app.metadataCache.getFileCache(view.file)?.headings ?? []).map((h) => ({ heading: h.heading, level: h.level, line: h.position.start.line }));
    const section = sectionAt(headings, view.editor.getCursor().line);
    new Notice(this.basket.add(view.file.path, section) ? t("addedToBasket") : t("alreadyInBasket"));
  }

  private async randomStrong(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) return void new Notice(t("noActiveNote"));
    const view = await this.connections.related({ kind: "note", path: file.path }).catch(() => null);
    const strong = (view?.results ?? []).filter((r) => r.label === "strong");
    if (strong.length === 0) return void new Notice(view?.state === "offline" ? t("engineOffBanner") : t("noStrong"));
    const pick = strong[Math.floor(Math.random() * strong.length)]!;
    await this.openResult(pick.blocks?.[0] ?? pick, false);
  }

  private registerMenus(): void {
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        const text = editor.getSelection().trim();
        const path = info.file?.path;
        if (text && path) {
          menu.addItem((i) => i.setTitle(`${t("name")}: ${t("cmdAskSelection")}`).setIcon("message-circle-question").onClick(() => void this.openAsk(text.replace(/\s+/g, " ").slice(0, 600))));
          menu.addItem((i) =>
            i.setTitle(`${t("name")}: ${t("cmdConnectionsSelection")}`).setIcon("waypoints").onClick(() => void this.reveal<ConnectionsView>(CONNECTIONS_VIEW, "right").then((v) => v?.showSelection(path, text))),
          );
        }
        if (path) menu.addItem((i) => i.setTitle(`${t("name")}: ${t("cmdAddBlockToBasket")}`).setIcon("shopping-basket").onClick(() => this.addCursorBlockToBasket()));
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((i) => i.setTitle(`${t("name")}: ${t("addToBasket")}`).setIcon("shopping-basket").onClick(() => new Notice(this.basket.add(file.path) ? t("addedToBasket") : t("alreadyInBasket"))));
        menu.addItem((i) => i.setTitle(`${t("name")}: ${t("graphOpenHere")}`).setIcon("git-fork").onClick(() => void this.openGraph(file.path)));
      }),
    );
  }
}
