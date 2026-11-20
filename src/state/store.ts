// The data.json store. Writes are debounced by 1 second and never happen on a keystroke.

import type { Filter } from "@trova/contract";
import { defaultData, pairKey, type TrovaData, type TrovaSettings } from "../settings.js";
import { sanitizeData } from "./sanitize.js";

export interface Persistence {
  load(): Promise<unknown>;
  save(data: TrovaData): Promise<void>;
  /** Copies the data file as it is now, before a repair overwrites it. Returns the copy's name. */
  backup?(): Promise<string | null>;
}

/** A failed save is tried again after these delays; after the last, the next change tries again. */
const SAVE_RETRY_MS = [2000, 10_000, 60_000];

export const SAVE_DEBOUNCE_MS = 1000;

/** Rewrites one id when its source was renamed. Block ids keep their heading path. */
export function renameId(id: string, oldSource: string, newSource: string): string {
  if (id === oldSource) return newSource;
  if (id.startsWith(`${oldSource}#`)) return newSource + id.slice(oldSource.length);
  return id;
}

export class DataStore {
  data: TrovaData = defaultData();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();

  constructor(private persistence: Persistence) {}

  /** What `load` repaired, for the notice; empty when the file was sound. */
  problems: string[] = [];
  /** True when the file could not be read at all, such as a file that is not valid JSON. */
  loadFailed = false;
  /** The name of the copy made of a damaged file before it was repaired, or null. */
  backupName: string | null = null;
  private saveFailures = 0;

  /**
   * Loads and checks the data. It never throws: an unreadable file gives the defaults, and a field
   * that does not fit falls back to its default (`sanitizeData`). When something was repaired,
   * the original file is copied first, then the repaired data is saved, so the repair happens once.
   */
  async load(): Promise<void> {
    let raw: unknown = null;
    try {
      raw = await this.persistence.load();
    } catch (err) {
      this.loadFailed = true;
      console.error("Trova: could not read data.json; starting from the defaults", err);
    }
    const { data, problems } = sanitizeData(raw);
    this.data = data;
    this.problems = problems;
    if (problems.length) console.warn("Trova: repaired data.json", problems);
    if (!this.loadFailed && problems.length === 0) return;
    this.backupName = await (this.persistence.backup?.() ?? Promise.resolve(null)).catch(() => null);
    // Without a copy, a file that could not be read is left as it is, so nothing is lost; the
    // next change the user makes saves the repaired data.
    if (this.backupName) await this.flush();
  }

  get settings(): TrovaSettings {
    return this.data.settings;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Marks the data as changed: listeners run now, the write happens after the debounce. */
  touch(): void {
    for (const l of this.listeners) l();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), SAVE_DEBOUNCE_MS);
  }

  /** Writes the data now. A failed write is logged and tried again later; it never throws. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      await this.persistence.save(this.data);
      this.saveFailures = 0;
    } catch (err) {
      const delay = SAVE_RETRY_MS[this.saveFailures];
      this.saveFailures++;
      console.error("Trova: could not save data.json", err);
      if (delay !== undefined) this.timer = setTimeout(() => void this.flush(), delay);
      else this.saveFailures = 0;
    }
  }

  updateSettings(patch: Partial<TrovaSettings>): void {
    Object.assign(this.data.settings, patch);
    this.touch();
  }

  // ---------- pins and hides ----------

  private toggle(map: Record<string, string[]>, anchor: string, id: string, on: boolean): void {
    const list = (map[anchor] ??= []);
    const at = list.indexOf(id);
    if (on && at === -1) list.push(id);
    if (!on && at !== -1) list.splice(at, 1);
    if (list.length === 0) delete map[anchor];
    this.touch();
  }

  pins(anchor: string): string[] {
    return this.data.pins[anchor] ?? [];
  }
  hides(anchor: string): string[] {
    return this.data.hides[anchor] ?? [];
  }
  setPinned(anchor: string, id: string, on: boolean): void {
    this.toggle(this.data.pins, anchor, id, on);
  }
  setHidden(anchor: string, id: string, on: boolean): void {
    this.toggle(this.data.hides, anchor, id, on);
  }

  setConnectionFilters(filters: Filter[]): void {
    this.data.filters.connections = filters;
    this.touch();
  }

  // ---------- vault care ----------

  isNotDuplicate(a: string, b: string): boolean {
    return this.data.care.notDuplicates.includes(pairKey(a, b));
  }
  /** Marks a near-duplicate pair as not a duplicate, or restores it. */
  setNotDuplicate(a: string, b: string, on: boolean): void {
    const key = pairKey(a, b);
    const list = this.data.care.notDuplicates.filter((k) => k !== key);
    this.data.care.notDuplicates = on ? [...list, key] : list;
    this.touch();
  }
  isKeptUnlinked(source: string): boolean {
    return this.data.care.keepUnlinked.includes(source);
  }
  /** Keeps a note off the orphan list, or puts it back. */
  setKeptUnlinked(source: string, on: boolean): void {
    const list = this.data.care.keepUnlinked.filter((s) => s !== source);
    this.data.care.keepUnlinked = on ? [...list, source] : list;
    this.touch();
  }

  /** Rewrites ids after a rename, so pins, hides and Vault care choices survive it. */
  renameSource(oldSource: string, newSource: string): void {
    let changed = false;
    const care = this.data.care;
    const pairs = care.notDuplicates.map((key) => {
      const [a, b] = key.split("\n") as [string, string];
      return pairKey(renameId(a, oldSource, newSource), renameId(b, oldSource, newSource));
    });
    if (pairs.some((k, i) => k !== care.notDuplicates[i])) {
      care.notDuplicates = [...new Set(pairs)];
      changed = true;
    }
    const kept = care.keepUnlinked.map((s) => renameId(s, oldSource, newSource));
    if (kept.some((s, i) => s !== care.keepUnlinked[i])) {
      care.keepUnlinked = [...new Set(kept)];
      changed = true;
    }
    for (const map of [this.data.pins, this.data.hides]) {
      for (const anchor of Object.keys(map)) {
        const list = map[anchor]!;
        const next = list.map((id) => renameId(id, oldSource, newSource));
        if (next.some((id, i) => id !== list[i])) {
          map[anchor] = next;
          changed = true;
        }
        const newAnchor = renameId(anchor, oldSource, newSource);
        if (newAnchor !== anchor) {
          map[newAnchor] = [...new Set([...(map[newAnchor] ?? []), ...map[anchor]!])];
          delete map[anchor];
          changed = true;
        }
      }
    }
    if (changed) this.touch();
  }

  /** Drops ids of a deleted source. */
  removeSource(source: string): void {
    let changed = false;
    const care = this.data.care;
    const gone = (id: string) => id === source || id.startsWith(`${source}#`);
    const pairs = care.notDuplicates.filter((key) => !key.split("\n").some(gone));
    const kept = care.keepUnlinked.filter((s) => !gone(s));
    if (pairs.length !== care.notDuplicates.length || kept.length !== care.keepUnlinked.length) {
      care.notDuplicates = pairs;
      care.keepUnlinked = kept;
      changed = true;
    }
    for (const map of [this.data.pins, this.data.hides]) {
      for (const anchor of Object.keys(map)) {
        if (anchor === source) {
          delete map[anchor];
          changed = true;
          continue;
        }
        const next = map[anchor]!.filter((id) => id !== source && !id.startsWith(`${source}#`));
        if (next.length !== map[anchor]!.length) {
          if (next.length) map[anchor] = next;
          else delete map[anchor];
          changed = true;
        }
      }
    }
    if (changed) this.touch();
  }
}

/** A small LRU cache. Result caches hold 200 anchors. */
export class Lru<K, V> {
  private map = new Map<K, V>();
  constructor(private max = 200) {}
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }
  delete(key: K): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  keys(): K[] {
    return [...this.map.keys()];
  }
  get size(): number {
    return this.map.size;
  }
}

/** Per-device state: query history, last-opened times and the onboarding flag. */
export interface LocalBackend {
  load(key: string): unknown;
  save(key: string, value: unknown): void;
}

export interface HistoryEntry {
  query: string;
  mode: "auto" | "fast" | "deep";
  at: number;
}

export class LocalState {
  private opened: Record<string, number>;
  private openedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private backend: LocalBackend) {
    const opened = this.read("trova-opened");
    this.opened = {};
    if (typeof opened === "object" && opened !== null && !Array.isArray(opened)) {
      for (const [path, at] of Object.entries(opened)) if (typeof at === "number" && Number.isFinite(at)) this.opened[path] = at;
    }
  }

  history(): HistoryEntry[] {
    const raw = this.read("trova-history");
    if (!Array.isArray(raw)) return [];
    return raw.filter((h): h is HistoryEntry => typeof h === "object" && h !== null && typeof h.query === "string" && ["auto", "fast", "deep"].includes(h.mode) && typeof h.at === "number");
  }

  /** Stores a value; storage that is full or unavailable is logged, not thrown. */
  private write(key: string, value: unknown): void {
    try {
      this.backend.save(key, value);
    } catch (err) {
      console.error(`Trova: could not store ${key}`, err);
    }
  }

  /** Reads a stored value; storage that throws, or holds nothing, gives null. */
  private read(key: string): unknown {
    try {
      return this.backend.load(key) ?? null;
    } catch {
      return null;
    }
  }

  addHistory(entry: HistoryEntry): void {
    const list = this.history().filter((h) => h.query !== entry.query);
    list.unshift(entry);
    this.write("trova-history", list.slice(0, 50));
  }

  clearHistory(): void {
    this.write("trova-history", []);
  }

  get onboarded(): boolean {
    return this.read("trova-onboarded") === true;
  }
  set onboarded(v: boolean) {
    this.write("trova-onboarded", v);
  }

  /** A stored value, unchecked: callers check its shape before using it. Null when missing. */
  get<T>(key: string): T | null {
    return this.read(`trova-${key}`) as T | null;
  }
  set(key: string, value: unknown): void {
    this.write(`trova-${key}`, value);
  }

  // Last-opened times feed the recency boost and Rediscover.
  markOpened(path: string, at = Date.now()): void {
    this.opened[path] = at;
    if (this.openedTimer) return;
    this.openedTimer = setTimeout(() => {
      this.openedTimer = null;
      this.write("trova-opened", this.opened);
    }, 2000);
  }
  lastOpened(path: string): number | undefined {
    return this.opened[path];
  }
  daysSinceOpened(path: string, now = Date.now()): number | null {
    const at = this.opened[path];
    return at === undefined ? null : (now - at) / 86_400_000;
  }
  recentPaths(limit: number): string[] {
    return Object.entries(this.opened)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([p]) => p);
  }
  renameOpened(from: string, to: string): void {
    if (this.opened[from] === undefined) return;
    this.opened[to] = this.opened[from]!;
    delete this.opened[from];
    this.write("trova-opened", this.opened);
  }
}
