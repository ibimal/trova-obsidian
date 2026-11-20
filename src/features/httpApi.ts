// The opt-in Local HTTP API: a separate port on 127.0.0.1 with its own user-visible token and
// read-only endpoints that mirror search, ask and related. Desktop only.

import type { Result, ResultBatch } from "@trova/contract";
import type TrovaPlugin from "../main.js";

interface Req {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}
interface Res {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}
interface HttpServer {
  listen(port: number, host: string, cb: () => void): void;
  close(cb?: () => void): void;
  on(event: string, cb: (err: Error) => void): void;
}

async function last(stream: AsyncIterable<ResultBatch>, keepVec: boolean): Promise<Result[]> {
  let results: Result[] = [];
  for await (const batch of stream) {
    if (batch.stage === "vec" && !keepVec) continue;
    if (batch.results.length) results = batch.results;
  }
  return results;
}

export class HttpApi {
  private server: HttpServer | null = null;

  constructor(private plugin: TrovaPlugin) {}

  start(port: number, token: string): Promise<void> {
    this.stop();
    const http = (globalThis as unknown as { require: (id: string) => { createServer(h: (req: Req, res: Res) => void): HttpServer } }).require("http");
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization", "Access-Control-Allow-Methods": "GET, OPTIONS" };
    const send = (res: Res, status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify(body));
    };
    const server = http.createServer((req, res) => {
      void (async () => {
        if (req.method === "OPTIONS") {
          res.writeHead(204, cors);
          return res.end();
        }
        // Read-only: only GET is served.
        if (req.method !== "GET") return send(res, 405, { error: "Only GET is allowed" });
        if (!token || req.headers["authorization"] !== `Bearer ${token}`) return send(res, 401, { error: "Missing or wrong token" });
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const q = url.searchParams.get("q") ?? "";
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 20)));
        const { api } = this.plugin;
        try {
          if (url.pathname === "/search") return send(res, 200, await last(api.search(q, { limit }), false));
          if (url.pathname === "/ask") {
            const mode = url.searchParams.get("mode");
            return send(res, 200, await last(api.ask(q, { limit, mode: mode === "fast" || mode === "deep" ? mode : "auto" }), true));
          }
          if (url.pathname === "/related") {
            const path = url.searchParams.get("path");
            const text = url.searchParams.get("text");
            const block = url.searchParams.get("block");
            if (!path && !text) return send(res, 400, { error: "related needs path or text" });
            return send(res, 200, await api.related(text ? { text } : block ? { path: path!, block } : { path: path! }, { limit }));
          }
          return send(res, 404, { error: "Unknown endpoint. Use /search, /ask or /related" });
        } catch (err) {
          return send(res, 503, { error: (err as Error).message });
        }
      })();
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.on("error", (err) => reject(err));
      server.listen(port, "127.0.0.1", () => resolve());
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}
