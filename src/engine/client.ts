// EngineClient: fetch with AbortController, NDJSON streams and Server-Sent Events. `requestUrl`
// cannot stream, so everything uses fetch.

import { EngineError, type EngineEvent, type EngineEventName, type ErrorBody, type ResultBatch } from "@trova/contract";

export class EngineClient {
  constructor(
    readonly base: string,
    private token: string,
  ) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", "X-Request-Id": crypto.randomUUID() };
  }

  private async fail(res: Response): Promise<never> {
    const body = (await res.json().catch(() => null)) as ErrorBody | null;
    const retryAfter = Number(res.headers.get("Retry-After"));
    throw new EngineError(
      body?.error?.code ?? (res.status === 401 ? "unauthorized" : "internal"),
      body?.error?.message ?? `HTTP ${res.status}`,
      body?.error?.retryable ?? false,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    );
  }

  async json<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(this.base + path, { method, headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body), signal });
    if (!res.ok) await this.fail(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async *lines(res: Response): AsyncGenerator<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          yield buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
        }
      }
      if (buffer.trim()) yield buffer;
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }

  /** A streaming endpoint: one batch per NDJSON line. An error line ends the stream by throwing. */
  async *stream(path: string, body: unknown, signal?: AbortSignal): AsyncGenerator<ResultBatch> {
    const res = await fetch(this.base + path, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal });
    if (!res.ok || !res.body) await this.fail(res);
    for await (const line of this.lines(res)) {
      if (!line.trim()) continue;
      const value = JSON.parse(line) as ResultBatch & Partial<ErrorBody>;
      if (value.error && !value.stage) throw new EngineError(value.error.code, value.error.message, value.error.retryable);
      yield value;
    }
  }

  /** Reads the event stream until it ends or the signal aborts. Resolves when the stream drops. */
  async events(onEvent: (e: EngineEvent) => void, signal: AbortSignal, onOpen?: () => void): Promise<void> {
    const res = await fetch(`${this.base}/v1/events`, { headers: this.headers(), signal });
    if (!res.ok || !res.body) await this.fail(res);
    onOpen?.();
    let event = "";
    let data = "";
    for await (const raw of this.lines(res)) {
      const line = raw.replace(/\r$/, "");
      if (line === "") {
        if (event && data) {
          try {
            onEvent({ event: event as EngineEventName, data: JSON.parse(data) as Record<string, unknown> });
          } catch {
            /* a malformed event is skipped */
          }
        }
        event = "";
        data = "";
      } else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
  }

  static async health(base: string, timeoutMs = 1000): Promise<{ api: string; version: string; name: string } | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`${base}/health`, { signal: controller.signal });
      clearTimeout(timer);
      return res.ok ? ((await res.json()) as { api: string; version: string; name: string }) : null;
    } catch {
      return null;
    }
  }
}
