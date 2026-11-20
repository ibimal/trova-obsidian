// EngineManager: the engine lifecycle from the spec (find, start, wait, register, run, upgrade),
// the retry schedule, batched index/sync calls, and the error handling table.

import {
  API_MAJOR,
  EngineError,
  type AskRequest,
  type Capability,
  type CollectionAddRequest,
  type DocumentBody,
  type DuplicatesResponse,
  type EngineEvent,
  type GetRequest,
  type GraphRequest,
  type GraphResponse,
  type IndexStatus,
  type RelatedRequest,
  type RelatedResponse,
  type ResultBatch,
  type ScoreRequest,
  type ScoreResponse,
  type SearchRequest,
  type SyncRequest,
  type TopicsResponse,
} from "@trova/contract";
import { EngineClient } from "./client.js";

export type EngineState = "disabled" | "idle" | "connecting" | "ready" | "offline" | "not-found" | "wrong-version";

export interface EngineSnapshot {
  state: EngineState;
  /** Why the engine is offline, including captured error output from a failed start. */
  reason?: string;
  status?: IndexStatus;
  /** The engine's API version when it is the wrong one. */
  gotApi?: string;
  progress?: { kind: string; done: number; total: number };
  error?: string;
}

export interface Endpoint {
  base: string;
  token: string;
  api: string;
}

/** What the manager needs from its host. The plugin wires this to Obsidian and Node. */
export interface EngineHost {
  desktop: boolean;
  mode(): "managed" | "external";
  /** Reads daemon.json, or the external address from the settings. */
  endpoint(): Endpoint | null;
  findBinary(): string | null;
  spawn(binary: string): { errorOutput(): string; exited(): boolean };
  /** The vault collection and the outside folders to register. */
  collections(): Promise<CollectionAddRequest[]>;
  /** True once the user clicked Start on the welcome screen. Nothing is indexed before that. */
  mayIndex(): boolean;
  log(message: string): void;
}

export const RETRY_SCHEDULE_MS = [1000, 2000, 4000, 8000];
export const RETRY_STEADY_MS = 30_000;
export const SYNC_DEBOUNCE_MS = 2000;
const WAIT_POLL_MS = 250;
const WAIT_TOTAL_MS = 15_000;

export class EngineOffline extends Error {
  constructor() {
    super("The engine is offline");
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class EngineManager {
  snapshot: EngineSnapshot = { state: "idle" };
  vaultCollection = "";
  private client: EngineClient | null = null;
  private listeners = new Set<(s: EngineSnapshot) => void>();
  private eventListeners = new Set<(e: EngineEvent) => void>();
  private eventsAbort: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private stopped = false;
  private connecting: Promise<void> | null = null;
  private pending = new Map<string, { changed: Set<string>; deleted: Set<string>; renamed: { from: string; to: string }[]; full: boolean }>();
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private unsupported = new Set<string>();
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private allCollections: string[] = [];

  constructor(private host: EngineHost) {}

  // ---------- state ----------

  onChange(cb: (s: EngineSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onEvent(cb: (e: EngineEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  private set(patch: Partial<EngineSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l(this.snapshot);
  }

  get ready(): boolean {
    return this.snapshot.state === "ready" && this.client !== null;
  }

  has(capability: Capability): boolean {
    return this.ready && !this.unsupported.has(capability) && (this.snapshot.status?.capabilities.includes(capability) ?? false);
  }

  collections(): string[] {
    return this.allCollections;
  }

  // ---------- lifecycle ----------

  /** Called inside workspace.onLayoutReady. Never throws and never blocks the caller. */
  start(): void {
    if (!this.host.desktop) {
      this.set({ state: "disabled" });
      return;
    }
    this.stopped = false;
    void this.connect(false);
  }

  /** "Continue without engine": Instant search keeps working from the worker. */
  disable(): void {
    this.stop();
    this.set({ state: "disabled", reason: undefined });
  }

  /** The Start engine button and the retry timer both land here. */
  connect(userAction: boolean): Promise<void> {
    if (this.connecting) return this.connecting;
    this.stopped = false;
    this.connecting = this.doConnect(userAction).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async tryEndpoint(): Promise<"ok" | "none" | "wrong-version"> {
    const ep = this.host.endpoint();
    if (!ep) return "none";
    const health = await EngineClient.health(ep.base);
    if (!health) return "none";
    // Upgrade: a different major API version is never connected to.
    if (Number(String(health.api).split(".")[0]) !== API_MAJOR) {
      this.set({ state: "wrong-version", gotApi: health.api, reason: `API ${health.api}` });
      return "wrong-version";
    }
    this.client = new EngineClient(ep.base, ep.token);
    return "ok";
  }

  private async doConnect(userAction: boolean): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const firstAttempt = this.snapshot.state === "idle" || userAction;
    if (firstAttempt) this.set({ state: "connecting", reason: undefined });
    try {
      // 1. Find.
      let found = await this.tryEndpoint();
      if (found === "wrong-version") return;
      // 2. Start, in Managed mode.
      if (found === "none" && this.host.mode() === "managed") {
        const binary = this.host.findBinary();
        if (!binary) {
          this.set({ state: "not-found", reason: "The trova binary was not found" });
          this.scheduleRetry();
          return;
        }
        const spawned = this.host.spawn(binary);
        // 3. Wait: poll daemon.json and /health every 250 ms for up to 15 seconds.
        const deadline = Date.now() + WAIT_TOTAL_MS;
        while (Date.now() < deadline && !this.stopped) {
          await sleep(WAIT_POLL_MS);
          found = await this.tryEndpoint();
          if (found !== "none") break;
          if (spawned.exited() && spawned.errorOutput() && !this.host.endpoint()) break;
        }
        if (found === "wrong-version") return;
        if (found === "none") {
          this.set({ state: "offline", reason: spawned.errorOutput() || "The engine did not start within 15 seconds" });
          this.scheduleRetry();
          return;
        }
      }
      if (found === "none") {
        this.set({ state: "offline", reason: "No engine answers at the configured address" });
        this.scheduleRetry();
        return;
      }
      // 4. Register.
      await this.register();
      this.retryCount = 0;
      this.set({ state: "ready", reason: undefined, error: undefined });
      this.emitEvent({ event: "engine.state", data: { state: "ready" } });
      this.openEvents();
      this.flushSync();
    } catch (err) {
      this.host.log(`connect failed: ${(err as Error).message}`);
      this.client = null;
      this.set({ state: "offline", reason: (err as Error).message });
      this.scheduleRetry();
    }
  }

  private async register(): Promise<void> {
    const client = this.client!;
    const wanted = await this.host.collections();
    this.vaultCollection = wanted[0]?.name ?? "";
    this.allCollections = wanted.map((c) => c.name);
    const existing = (await client.json<{ collections: { name: string; path: string }[] }>("GET", "/v1/collections")).collections;
    for (const c of wanted) {
      const known = existing.find((e) => e.name === c.name);
      await client.json("POST", "/v1/collections", c);
      if (this.host.mayIndex() && !known) await client.json("POST", "/v1/index/sync", { collection: c.name, full: true } satisfies SyncRequest);
    }
    if (this.host.mayIndex()) {
      for (const c of wanted) {
        if (existing.some((e) => e.name === c.name)) await client.json("POST", "/v1/index/sync", { collection: c.name, full: true } satisfies SyncRequest);
      }
    }
    await this.refreshStatus();
  }

  /** Re-sends collections after a settings change (scope, attachments, folder context, outside folders). */
  async reregister(): Promise<void> {
    if (!this.ready) return;
    try {
      const before = new Set(this.allCollections);
      await this.register();
      for (const name of before) {
        if (!this.allCollections.includes(name)) await this.client!.json("DELETE", `/v1/collections?name=${encodeURIComponent(name)}`).catch(() => undefined);
      }
      this.set({});
    } catch (err) {
      this.handleError(err);
    }
  }

  /** Starts the first full index after the user clicks Start on the welcome screen. */
  async startIndexing(): Promise<void> {
    if (!this.ready) return;
    for (const name of this.allCollections) await this.call(() => this.client!.json("POST", "/v1/index/sync", { collection: name, full: true }));
    await this.refreshStatus();
  }

  private openEvents(): void {
    this.eventsAbort?.abort();
    const abort = new AbortController();
    this.eventsAbort = abort;
    const client = this.client!;
    void client
      .events((e) => this.onEngineEvent(e), abort.signal)
      .catch(() => undefined)
      .then(() => {
        if (abort.signal.aborted || this.stopped) return;
        // 5. A dropped event stream triggers the retry schedule.
        this.client = null;
        this.set({ state: "offline", reason: "The connection to the engine dropped" });
        this.emitEvent({ event: "engine.state", data: { state: "offline" } });
        this.scheduleRetry();
      });
    if (this.keepAlive) clearInterval(this.keepAlive);
    // qmd unloads idle models after 5 minutes; keep them warm while Obsidian is focused.
    this.keepAlive = setInterval(() => {
      if (this.ready && typeof document !== "undefined" && document.hasFocus()) void this.client?.json("POST", "/v1/keepalive", {}).catch(() => undefined);
    }, 4 * 60_000);
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = RETRY_SCHEDULE_MS[this.retryCount] ?? RETRY_STEADY_MS;
    this.retryCount++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect(false);
    }, delay);
  }

  private emitEvent(e: EngineEvent): void {
    for (const l of this.eventListeners) l(e);
  }

  private onEngineEvent(e: EngineEvent): void {
    if (e.event === "index.progress") {
      this.set({ progress: { kind: String(e.data["stage"] ?? e.data["kind"] ?? ""), done: Number(e.data["done"] ?? 0), total: Number(e.data["total"] ?? 0) } });
    } else if (e.event === "index.ready") {
      this.set({ progress: undefined });
      void this.refreshStatus();
    } else if (e.event === "engine.state") {
      if (e.data["state"] === "error") this.set({ error: String(e.data["message"] ?? "") });
      void this.refreshStatus();
    } else if (e.event === "model.changed") {
      void this.refreshStatus();
    }
    this.emitEvent(e);
  }

  async refreshStatus(): Promise<IndexStatus | undefined> {
    if (!this.client) return undefined;
    try {
      const status = await this.client.json<IndexStatus>("GET", "/v1/index/status");
      this.set({ status, ...(status.jobs.length === 0 ? { progress: undefined } : {}) });
      return status;
    } catch (err) {
      this.handleError(err);
      return undefined;
    }
  }

  /** 6. Leave: closing Obsidian never stops the daemon; only the plugin's connections close. */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.syncTimer) clearTimeout(this.syncTimer);
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.retryTimer = this.syncTimer = this.keepAlive = null;
    this.eventsAbort?.abort();
    this.client = null;
  }

  // ---------- calls with the error handling table ----------

  private handleError(err: unknown): void {
    if (!(err instanceof EngineError)) {
      // A network failure: the engine went away.
      if (err instanceof Error && err.name === "AbortError") return;
      if (this.client) {
        this.client = null;
        this.set({ state: "offline", reason: (err as Error)?.message ?? "Network error" });
        this.scheduleRetry();
      }
      return;
    }
    if (err.code === "bad_request") this.host.log(`bad_request: ${err.message}`);
    if (err.code === "internal") this.set({ error: err.message });
  }

  /** Runs one engine call with the documented responses to each error code. */
  private async call<T>(fn: () => Promise<T>, capability?: Capability): Promise<T> {
    if (!this.client) throw new EngineOffline();
    if (capability && this.unsupported.has(capability)) throw new EngineError("unsupported", `The engine lacks ${capability}`);
    try {
      return await fn();
    } catch (err) {
      if (err instanceof EngineError) {
        if (err.code === "unauthorized") {
          // Re-read daemon.json once, then show engine offline.
          const ep = this.host.endpoint();
          if (ep) {
            this.client = new EngineClient(ep.base, ep.token);
            try {
              return await fn();
            } catch (again) {
              err = again;
            }
          }
          if (err instanceof EngineError && err.code === "unauthorized") {
            this.client = null;
            this.set({ state: "offline", reason: "The engine rejected the token" });
            this.scheduleRetry();
          }
        } else if (err.code === "busy") {
          await sleep(200);
          return fn();
        } else if (err.code === "model_loading") {
          await sleep(err.retryAfterMs ?? 1000);
          return fn();
        } else if (err.code === "unsupported" && capability) {
          this.unsupported.add(capability);
        }
      }
      this.handleError(err);
      throw err;
    }
  }

  private async *streamCall(path: string, body: unknown, signal?: AbortSignal): AsyncGenerator<ResultBatch> {
    if (!this.client) throw new EngineOffline();
    let attempt = 0;
    for (;;) {
      try {
        yield* this.client.stream(path, body, signal);
        return;
      } catch (err) {
        if (signal?.aborted) return;
        if (err instanceof EngineError && attempt === 0 && (err.code === "busy" || err.code === "model_loading")) {
          attempt++;
          await sleep(err.code === "busy" ? 200 : (err.retryAfterMs ?? 1000));
          continue;
        }
        this.handleError(err);
        throw err;
      }
    }
  }

  search(req: SearchRequest, signal?: AbortSignal): AsyncGenerator<ResultBatch> {
    return this.streamCall("/v1/search", req, signal);
  }
  ask(req: AskRequest, signal?: AbortSignal): AsyncGenerator<ResultBatch> {
    return this.streamCall("/v1/ask", req, signal);
  }
  related(req: RelatedRequest, signal?: AbortSignal): Promise<RelatedResponse> {
    return this.call(() => this.client!.json("POST", "/v1/related", req, signal), "relatedByVector");
  }
  graph(req: GraphRequest, signal?: AbortSignal): Promise<GraphResponse> {
    return this.call(() => this.client!.json("POST", "/v1/graph", req, signal), "graph");
  }
  score(req: ScoreRequest, signal?: AbortSignal): Promise<ScoreResponse> {
    return this.call(() => this.client!.json("POST", "/v1/score", req, signal));
  }
  get(req: GetRequest, signal?: AbortSignal): Promise<DocumentBody> {
    return this.call(() => this.client!.json("POST", "/v1/documents/get", req, signal));
  }
  metadataKeys(): Promise<{ keys: Record<string, string[]> }> {
    return this.call(() => this.client!.json("GET", "/v1/metadata/keys"));
  }
  duplicates(start: boolean): Promise<DuplicatesResponse> {
    return this.call(() => this.client!.json(start ? "POST" : "GET", "/v1/duplicates", start ? {} : undefined), "duplicates");
  }
  topics(start: boolean): Promise<TopicsResponse> {
    return this.call(() => this.client!.json(start ? "POST" : "GET", "/v1/topics", start ? {} : undefined), "topics");
  }
  downloadModels(): Promise<{ jobId: string }> {
    return this.call(() => this.client!.json("POST", "/v1/models/download", {}));
  }
  cancelJob(jobId: string): Promise<void> {
    return this.call(() => this.client!.json("POST", `/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {}));
  }
  pushAttachmentText(path: string, text: string): Promise<void> {
    return this.call(() => this.client!.json("POST", "/v1/attachments/text", { collection: this.vaultCollection, path, text }));
  }
  setDebug(on: boolean): void {
    void this.client?.json("POST", "/v1/debug", { on }).catch(() => undefined);
  }
  async setPaused(paused: boolean): Promise<void> {
    await this.call(() => this.client!.json("POST", paused ? "/v1/index/pause" : "/v1/index/resume", {}));
    await this.refreshStatus();
  }

  // ---------- index/sync batching ----------

  private batch(collection: string) {
    let b = this.pending.get(collection);
    if (!b) this.pending.set(collection, (b = { changed: new Set(), deleted: new Set(), renamed: [], full: false }));
    return b;
  }

  /** Vault events go to index/sync in batches, debounced by 2 seconds. */
  queueSync(change: { changed?: string; deleted?: string; renamed?: { from: string; to: string }; full?: boolean }, collection = this.vaultCollection): void {
    if (!collection || !this.host.mayIndex()) return;
    const b = this.batch(collection);
    if (change.changed) b.changed.add(change.changed);
    if (change.deleted) b.deleted.add(change.deleted);
    if (change.renamed) b.renamed.push(change.renamed);
    if (change.full) b.full = true;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.flushSync(), SYNC_DEBOUNCE_MS);
  }

  private flushSync(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    if (!this.ready) return;
    for (const [collection, b] of this.pending) {
      const req: SyncRequest = { collection, changed: [...b.changed], deleted: [...b.deleted], renamed: b.renamed, full: b.full };
      this.pending.delete(collection);
      void this.call(() => this.client!.json("POST", "/v1/index/sync", req)).catch(() => undefined);
    }
  }
}
