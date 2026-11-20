import type { LineMatch, ParsedQuery } from "@trova/contract";
import type { MentionHit, SearchOptions, SearchReply, WorkerDoc } from "./index.js";

/** Calls the main thread makes on the worker. Each returns a value over postMessage. */
export interface WorkerApi {
  upsertMeta(docs: WorkerDoc[]): void;
  upsertBodies(items: { path: string; body: string }[], dirty: boolean): void;
  remove(paths: string[]): void;
  rename(from: string, to: string, title: string): void;
  clearDirty(paths?: string[]): void;
  markDirty(paths: string[]): void;
  search(q: ParsedQuery, opts: SearchOptions): SearchReply;
  suggest(text: string, limit: number): { path: string; title: string; alias?: string; score: number }[];
  mentions(names: string[], selfPath: string): MentionHit[];
  inFile(path: string, q: ParsedQuery): LineMatch[];
  orphans(): string[];
  stats(): { files: number; bodies: number; dirty: number };
}

export interface WorkerRequest {
  id: number;
  method: keyof WorkerApi;
  args: unknown[];
}

/** Asks the worker to drop a queued read that the caller no longer wants. */
export interface WorkerCancel {
  cancel: number;
}

export type WorkerMessage = WorkerRequest | WorkerCancel;

/** Methods that do not change the index. The worker runs them before queued updates. */
export const READ_METHODS: ReadonlySet<keyof WorkerApi> = new Set<keyof WorkerApi>(["search", "suggest", "mentions", "inFile", "orphans", "stats"]);

export interface WorkerResponse {
  id: number;
  result?: unknown;
  error?: string;
}
