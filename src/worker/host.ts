// The main-thread side of the worker: typed calls over postMessage, each cancellable.

import { SearchIndex } from "./index.js";
import type { WorkerApi, WorkerRequest, WorkerResponse } from "./protocol.js";

type Async<T> = { [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<R> : never };

export interface WorkerHost extends Async<WorkerApi> {
  /** Like `search`, but rejects with an AbortError when the signal aborts. */
  call<K extends keyof WorkerApi>(method: K, args: Parameters<WorkerApi[K]>, signal?: AbortSignal): Promise<ReturnType<WorkerApi[K]>>;
  terminate(): void;
}

const METHODS: (keyof WorkerApi)[] = ["upsertMeta", "upsertBodies", "remove", "rename", "clearDirty", "markDirty", "search", "suggest", "mentions", "inFile", "orphans", "stats"];

function abortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

function build(send: (req: WorkerRequest, done: (res: WorkerResponse) => void) => void, terminate: () => void, cancel: (id: number) => void = () => undefined): WorkerHost {
  let seq = 0;
  const call = (method: keyof WorkerApi, args: unknown[], signal?: AbortSignal): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      let settled = false;
      const id = ++seq;
      const onAbort = () => {
        if (!settled) {
          settled = true;
          // The worker drops the request if it has not started it yet.
          cancel(id);
          reject(abortError());
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      send({ id, method, args }, (res) => {
        signal?.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        if (res.error) reject(new Error(res.error));
        else resolve(res.result);
      });
    });
  const host = { call, terminate } as unknown as WorkerHost & Record<string, unknown>;
  for (const m of METHODS) (host as Record<string, unknown>)[m] = (...args: unknown[]) => call(m, args);
  return host;
}

/** Starts the worker from its inlined source. */
export function startWorker(code: string): WorkerHost {
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  const worker = new Worker(url, { name: "trova" });
  const waiting = new Map<number, (res: WorkerResponse) => void>();
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const done = waiting.get(e.data.id);
    waiting.delete(e.data.id);
    done?.(e.data);
  };
  return build(
    (req, done) => {
      waiting.set(req.id, done);
      worker.postMessage(req);
    },
    () => {
      worker.terminate();
      URL.revokeObjectURL(url);
      waiting.clear();
    },
    (id) => {
      waiting.delete(id);
      worker.postMessage({ cancel: id });
    },
  );
}

/** Runs the index on the calling thread. Used by tests, and as a fallback where Workers are unavailable. */
export function startInline(): WorkerHost {
  const index = new SearchIndex();
  return build(
    (req, done) => {
      queueMicrotask(() => {
        try {
          const fn = (index as unknown as Record<string, (...a: unknown[]) => unknown>)[req.method]!;
          done({ id: req.id, result: fn.apply(index, req.args) });
        } catch (err) {
          done({ id: req.id, error: (err as Error).message });
        }
      });
    },
    () => undefined,
  );
}
