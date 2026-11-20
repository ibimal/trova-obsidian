// Finds and starts the daemon. Desktop only: Node modules are loaded lazily, and only after the
// caller has checked Platform.isDesktopApp. The plugin never downloads or installs executables.

import type { DaemonInfo } from "@trova/contract";

type NodeRequire = (id: string) => unknown;
function nodeRequire(): NodeRequire {
  return (globalThis as unknown as { require: NodeRequire }).require;
}

interface Fs {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: string): string;
  readdirSync(p: string): string[];
}
interface Os {
  homedir(): string;
  platform(): string;
}
interface PathMod {
  join(...p: string[]): string;
  delimiter: string;
}

function mods(): { fs: Fs; os: Os; path: PathMod } {
  const req = nodeRequire();
  return { fs: req("fs") as Fs, os: req("os") as Os, path: req("path") as PathMod };
}

export function trovaHome(): string {
  const { os, path } = mods();
  const env = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
  return env["TROVA_HOME"] || path.join(os.homedir(), ".cache", "trova");
}

export function readDaemonInfo(): DaemonInfo | null {
  try {
    const { fs, path } = mods();
    const info = JSON.parse(fs.readFileSync(path.join(trovaHome(), "daemon.json"), "utf8")) as DaemonInfo;
    return typeof info.port === "number" && typeof info.token === "string" ? info : null;
  } catch {
    return null;
  }
}

/** Folders that may hold the `trova` binary. macOS apps do not inherit the shell's PATH. */
export function searchDirs(): string[] {
  const { fs, os, path } = mods();
  const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
  const home = os.homedir();
  const dirs = [...(env["PATH"] ?? "").split(path.delimiter).filter(Boolean), "/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".bun", "bin"), path.join(home, ".npm-global", "bin")];
  if (env["NVM_BIN"]) dirs.push(env["NVM_BIN"]);
  try {
    const nvm = path.join(home, ".nvm", "versions", "node");
    const versions = fs.readdirSync(nvm).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) dirs.push(path.join(nvm, v, "bin"));
  } catch {
    /* nvm is not installed */
  }
  dirs.push(path.join(home, "Library", "pnpm"), path.join(home, ".local", "bin"), path.join(home, ".volta", "bin"));
  return [...new Set(dirs)];
}

export function findBinary(configured: string): string | null {
  const { fs, os, path } = mods();
  if (configured.trim()) return fs.existsSync(configured.trim()) ? configured.trim() : null;
  const names = os.platform() === "win32" ? ["trova.cmd", "trova.exe", "trova"] : ["trova"];
  for (const dir of searchDirs()) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface Spawned {
  /** Error output captured so far, shown when the daemon does not come up. */
  errorOutput(): string;
  exited(): boolean;
}

/** Spawns `trova watch` detached. Closing Obsidian never stops the daemon. */
export function spawnDaemon(binary: string, debug: boolean, embeddingModel: string, gpu: "auto" | "metal" | "cpu" = "auto"): Spawned {
  const { os, path } = mods();
  const cp = nodeRequire()("child_process") as {
    spawn(cmd: string, args: string[], opts: Record<string, unknown>): {
      stderr: { on(e: string, cb: (d: unknown) => void): void } | null;
      on(e: string, cb: (...a: unknown[]) => void): void;
      unref(): void;
    };
  };
  const proc = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process;
  // Homebrew's folders go first so `#!/usr/bin/env node` finds a current Node.
  const pathEnv = [...new Set(["/opt/homebrew/bin", "/usr/local/bin", ...searchDirs()])].join(path.delimiter);
  const env: Record<string, string | undefined> = { ...proc.env, PATH: pathEnv };
  if (debug) env["TROVA_DEBUG"] = "1";
  if (embeddingModel.trim()) env["QMD_EMBED_MODEL"] = embeddingModel.trim();
  // node-llama-cpp, which qmd runs its models on, reads this variable.
  if (gpu !== "auto") env["NODE_LLAMA_CPP_GPU"] = gpu === "cpu" ? "false" : "metal";
  let output = "";
  let exited = false;
  const child = cp.spawn(binary, ["watch"], { detached: true, stdio: ["ignore", "ignore", "pipe"], env, shell: os.platform() === "win32", windowsHide: true });
  child.stderr?.on("data", (d) => {
    output = (output + String(d)).slice(-4000);
  });
  child.on("error", (err) => {
    output += String((err as Error)?.message ?? err);
    exited = true;
  });
  child.on("exit", () => {
    exited = true;
  });
  child.unref();
  return { errorOutput: () => output.trim(), exited: () => exited };
}
