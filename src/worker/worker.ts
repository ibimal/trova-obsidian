// Worker entry. esbuild bundles this file to a string that main.js starts from a Blob URL.
//
// Requests run one per task, so a cancel message can arrive between two of them. Reads (a search,
// a suggestion) run before queued index updates: a keystroke never waits behind a batch of note
// bodies, and a search that was cancelled while it waited is dropped without running.

import { SearchIndex } from "./index.js";
import { READ_METHODS, type WorkerMessage, type WorkerRequest, type WorkerResponse } from "./protocol.js";

const index = new SearchIndex();
const scope = self as unknown as { onmessage: ((e: MessageEvent<WorkerMessage>) => void) | null; postMessage(msg: WorkerResponse): void };
const reads: WorkerRequest[] = [];
const writes: WorkerRequest[] = [];
let scheduled = false;

function run(): void {
  scheduled = false;
  const req = reads.shift() ?? writes.shift();
  if (!req) return;
  try {
    const fn = (index as unknown as Record<string, (...a: unknown[]) => unknown>)[req.method];
    if (typeof fn !== "function") throw new Error(`Unknown worker method ${req.method}`);
    scope.postMessage({ id: req.id, result: fn.apply(index, req.args) });
  } catch (err) {
    scope.postMessage({ id: req.id, error: (err as Error).message });
  }
  pump();
}

function pump(): void {
  if (scheduled || (reads.length === 0 && writes.length === 0)) return;
  scheduled = true;
  setTimeout(run, 0);
}

scope.onmessage = (e) => {
  const msg = e.data;
  if ("cancel" in msg) {
    const at = reads.findIndex((r) => r.id === msg.cancel);
    if (at !== -1) reads.splice(at, 1);
    return;
  }
  (READ_METHODS.has(msg.method) ? reads : writes).push(msg);
  pump();
};
