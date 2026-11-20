// VaultIndexer: feeds the worker from Obsidian's metadata cache and the vault, keeps it current on
// vault events, and forwards changes to the engine. Vault-wide work is chunked and yields to the
// UI between chunks; it pauses while the user types.

import { getAllTags, parseFrontMatterAliases, TFile, type App, type CachedMetadata } from "obsidian";
import { countWords, globToRegExp, isExcludedByFrontmatter, titleFromPath } from "@trova/contract";
import type { WorkerDoc } from "./worker/index.js";
import type { WorkerHost } from "./worker/host.js";

export const BODY_BATCH = 50;
const META_BATCH = 400;
const TYPING_PAUSE_MS = 400;

export interface IndexerDeps {
  app: App;
  worker: WorkerHost;
  scope(): { include: string[]; exclude: string[] };
  /** True when the engine keeps its own index, so worker bodies edited later form the overlay. */
  engineIndexes(): boolean;
  onChange(change: { changed?: string; deleted?: string; renamed?: { from: string; to: string } }): void;
  onProgress(done: number, total: number): void;
}

export function idle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 200 });
    else setTimeout(resolve, 0);
  });
}

export class VaultIndexer {
  progress = { done: 0, total: 0, running: false };
  private lastInput = 0;
  private stopped = false;
  private runId = 0;
  private excludeRes: RegExp[] = [];
  private includeRes: RegExp[] = [];

  constructor(private deps: IndexerDeps) {
    this.refreshScope();
  }

  refreshScope(): void {
    const scope = this.deps.scope();
    const ignore = ((this.deps.app.vault as unknown as { getConfig?: (k: string) => unknown }).getConfig?.("userIgnoreFilters") as string[] | undefined) ?? [];
    const toRe = (g: string) => {
      // Obsidian's excluded files are folder prefixes or /regex/ patterns.
      if (g.startsWith("/") && g.endsWith("/") && g.length > 2) {
        try {
          return new RegExp(g.slice(1, -1));
        } catch {
          return null;
        }
      }
      return globToRegExp(g);
    };
    this.excludeRes = [...scope.exclude, ...ignore].filter((g) => g.trim()).map(toRe).filter((r): r is RegExp => r !== null);
    this.includeRes = scope.include.filter((g) => g.trim()).map((g) => globToRegExp(g));
  }

  /** Obsidian's excluded files, as globs the engine understands. */
  excludeGlobs(): string[] {
    const ignore = ((this.deps.app.vault as unknown as { getConfig?: (k: string) => unknown }).getConfig?.("userIgnoreFilters") as string[] | undefined) ?? [];
    return [...this.deps.scope().exclude, ...ignore.filter((g) => !(g.startsWith("/") && g.endsWith("/")))].filter((g) => g.trim());
  }

  isExcluded(path: string, cache?: CachedMetadata | null): boolean {
    if (this.excludeRes.some((r) => r.test(path))) return true;
    if (this.includeRes.length > 0 && !this.includeRes.some((r) => r.test(path))) return true;
    return isExcludedByFrontmatter(cache?.frontmatter as Record<string, unknown> | undefined);
  }

  noteTyping(): void {
    this.lastInput = Date.now();
  }

  private async calm(): Promise<void> {
    await idle();
    while (Date.now() - this.lastInput < TYPING_PAUSE_MS && !this.stopped) await new Promise((r) => setTimeout(r, TYPING_PAUSE_MS));
  }

  docFor(file: TFile): WorkerDoc {
    const { metadataCache } = this.deps.app;
    const cache = file.extension === "md" ? metadataCache.getFileCache(file) : null;
    const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
    const frontmatter: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fm)) if (k !== "position") frontmatter[k] = v;
    return {
      path: file.path,
      title: titleFromPath(file.path),
      aliases: cache?.frontmatter ? (parseFrontMatterAliases(cache.frontmatter) ?? []) : [],
      tags: cache ? [...new Set((getAllTags(cache) ?? []).map((t) => t.replace(/^#/, "").toLowerCase()))] : [],
      links: Object.keys(metadataCache.resolvedLinks[file.path] ?? {}).filter((p) => p !== file.path),
      frontmatter,
      created: file.stat.ctime,
      modified: file.stat.mtime,
      wordCount: 0,
      excluded: this.isExcluded(file.path, cache),
      headings: (cache?.headings ?? []).map((h) => ({ text: h.heading, level: h.level, offset: h.position.start.offset })),
    };
  }

  /** First run: titles, aliases and headings at once; then note bodies, 50 files per batch. */
  async start(): Promise<void> {
    const { app, worker } = this.deps;
    this.stopped = false;
    // A second pass (a scope change, "Reindex now") replaces a pass that is still running.
    const run = ++this.runId;
    const live = () => run === this.runId && !this.stopped;
    const files = app.vault.getFiles();
    const notes = files.filter((f) => f.extension === "md");
    this.progress = { done: 0, total: notes.length, running: true };
    for (let i = 0; i < files.length && live(); i += META_BATCH) {
      await worker.upsertMeta(files.slice(i, i + META_BATCH).map((f) => this.docFor(f)));
      await idle();
    }
    for (let i = 0; i < notes.length && live(); i += BODY_BATCH) {
      await this.calm();
      if (!live()) return;
      const batch = notes.slice(i, i + BODY_BATCH);
      const items = await Promise.all(batch.map(async (f) => ({ path: f.path, body: await app.vault.cachedRead(f).catch(() => "") })));
      await worker.upsertBodies(items, false);
      if (!live()) return;
      this.progress.done = Math.min(notes.length, i + BODY_BATCH);
      this.deps.onProgress(this.progress.done, this.progress.total);
    }
    if (run !== this.runId) return;
    this.progress.running = false;
    this.deps.onProgress(this.progress.total, this.progress.total);
  }

  /**
   * The text of the note being edited, straight from the editor. Obsidian saves a note about two
   * seconds after the last keystroke; this makes a just-typed word findable before that.
   */
  async onEditorText(path: string, body: string): Promise<void> {
    await this.deps.worker.upsertBodies([{ path, body }], this.deps.engineIndexes());
  }

  stop(): void {
    this.stopped = true;
  }

  async reindexAll(): Promise<void> {
    this.refreshScope();
    await this.start();
  }

  // ---------- vault events ----------

  async onModify(file: TFile): Promise<void> {
    await this.deps.worker.upsertMeta([this.docFor(file)]);
    if (file.extension === "md") {
      const body = await this.deps.app.vault.cachedRead(file).catch(() => "");
      // With the engine indexing, this body is newer than the engine's copy: it joins the overlay.
      await this.deps.worker.upsertBodies([{ path: file.path, body }], this.deps.engineIndexes());
    }
    this.deps.onChange({ changed: file.path });
  }

  /** The metadata cache finished parsing: links, tags and headings may have changed. */
  async onCacheChanged(file: TFile, data?: string): Promise<void> {
    const doc = this.docFor(file);
    if (data !== undefined) doc.wordCount = countWords(data);
    await this.deps.worker.upsertMeta([doc]);
  }

  async onDelete(path: string): Promise<void> {
    await this.deps.worker.remove([path]);
    this.deps.onChange({ deleted: path });
  }

  async onRename(file: TFile, oldPath: string): Promise<void> {
    await this.deps.worker.rename(oldPath, file.path, titleFromPath(file.path));
    await this.deps.worker.upsertMeta([this.docFor(file)]);
    this.deps.onChange({ renamed: { from: oldPath, to: file.path } });
  }
}
