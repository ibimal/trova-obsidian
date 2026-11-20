// Checks the plugin's stored data before the plugin uses it. data.json can be edited by hand,
// synced half-written, or written by another version of the plugin, so every field is checked
// against its expected shape. A field that does not fit falls back to its default; one bad entry
// in a list is dropped without losing the rest. Nothing here throws.

import type { Filter, FilterOp } from "@trova/contract";
import { DEFAULT_SETTINGS, defaultData, type CareData, type TrovaData, type TrovaSettings } from "../settings.js";

export interface Sanitized {
  data: TrovaData;
  /** What was repaired, one line each; empty when the data was already sound. */
  problems: string[];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";

/** Settings that accept only some values. */
const CHOICES: Partial<Record<keyof TrovaSettings, readonly unknown[]>> = {
  typoTolerance: [0, 1, 2],
  connectionsRefresh: ["switch", "idle", "manual"],
  askMode: ["auto", "fast", "deep"],
  engineMode: ["managed", "external"],
  gpu: ["auto", "metal", "cpu"],
};

/** Numeric settings and the range each may take; a value outside it is clamped. */
const RANGES: Partial<Record<keyof TrovaSettings, { min: number; max: number; integer?: boolean }>> = {
  restoreQuerySeconds: { min: 0, max: 86_400 },
  graphLabels: { min: 0, max: 10, integer: true },
  askDeepSeconds: { min: 1, max: 600 },
  contextWarnTokens: { min: 0, max: 10_000_000, integer: true },
  httpApiPort: { min: 1, max: 65_535, integer: true },
};

const FILTER_OPS: readonly FilterOp[] = ["eq", "ne", "lt", "lte", "gt", "gte", "contains", "in"];

/**
 * A numeric setting brought into its allowed range, rounded when it must be whole. The settings
 * tab uses the same limits as the load check, so a typed value is never "repaired" later.
 */
export function clampSetting(key: keyof TrovaSettings, value: number): number {
  const range = RANGES[key];
  if (!range) return value;
  const n = range.integer ? Math.round(value) : value;
  return Math.max(range.min, Math.min(range.max, n));
}

function sanitizeSettings(raw: unknown, problems: string[]): TrovaSettings {
  const out: TrovaSettings = structuredClone(DEFAULT_SETTINGS);
  if (raw === undefined) return out;
  if (!isObj(raw)) {
    problems.push("settings: not an object; using the defaults");
    return out;
  }
  const target = out as unknown as Obj;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof TrovaSettings)[]) {
    if (!(key in raw)) continue;
    const value = raw[key];
    const fallback = DEFAULT_SETTINGS[key] as unknown;
    const bad = () => problems.push(`settings.${key}: unexpected value; using the default`);
    const choices = CHOICES[key];
    if (choices) {
      if (choices.includes(value)) target[key] = value;
      else bad();
      continue;
    }
    if (typeof fallback === "boolean") {
      if (typeof value === "boolean") target[key] = value;
      else bad();
    } else if (typeof fallback === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        bad();
        continue;
      }
      const n = clampSetting(key, value);
      if (n !== value) problems.push(`settings.${key}: out of range; set to ${n}`);
      target[key] = n;
    } else if (typeof fallback === "string") {
      if (isString(value)) target[key] = value;
      else bad();
    } else if (Array.isArray(fallback)) {
      if (!Array.isArray(value)) {
        bad();
        continue;
      }
      if (key === "outsideFolders") {
        const kept = value.filter((f): f is { name: string; path: string } => isObj(f) && isString(f["name"]) && isString(f["path"]));
        if (kept.length !== value.length) problems.push(`settings.${key}: dropped ${value.length - kept.length} bad entries`);
        target[key] = kept.map((f) => ({ name: f.name, path: f.path }));
      } else {
        const kept = value.filter(isString);
        if (kept.length !== value.length) problems.push(`settings.${key}: dropped ${value.length - kept.length} bad entries`);
        target[key] = kept;
      }
    } else if (key === "fieldWeights") {
      if (!isObj(value)) {
        bad();
        continue;
      }
      const weights = { ...DEFAULT_SETTINGS.fieldWeights };
      for (const field of Object.keys(weights) as (keyof typeof weights)[]) {
        const w = value[field];
        if (typeof w === "number" && Number.isFinite(w) && w >= 0) weights[field] = w;
        else if (field in value) problems.push(`settings.fieldWeights.${field}: unexpected value; using the default`);
      }
      target[key] = weights;
    }
  }
  return out;
}

/** A map of id lists, such as pins and hides; bad entries are dropped. */
function sanitizeIdMap(raw: unknown, name: string, problems: string[]): Record<string, string[]> {
  if (raw === undefined) return {};
  if (!isObj(raw)) {
    problems.push(`${name}: not an object; cleared`);
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const [anchor, ids] of Object.entries(raw)) {
    if (!Array.isArray(ids)) {
      problems.push(`${name}: dropped a bad entry`);
      continue;
    }
    const kept = [...new Set(ids.filter(isString))];
    if (kept.length !== ids.length) problems.push(`${name}: dropped bad ids`);
    if (kept.length) out[anchor] = kept;
  }
  return out;
}

function sanitizeFilters(raw: unknown, problems: string[]): Filter[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push("filters.connections: not a list; cleared");
    return [];
  }
  const out: Filter[] = [];
  for (const f of raw) {
    const value = isObj(f) ? f["value"] : undefined;
    const valueOk = isString(value) || (typeof value === "number" && Number.isFinite(value)) || (Array.isArray(value) && value.every(isString));
    if (!isObj(f) || !isString(f["field"]) || !FILTER_OPS.includes(f["op"] as FilterOp) || !valueOk) {
      problems.push("filters.connections: dropped a bad filter");
      continue;
    }
    out.push({ field: f["field"], op: f["op"] as FilterOp, value: value as Filter["value"], ...(f["negate"] === true ? { negate: true } : {}) });
  }
  return out;
}

function sanitizeStrings(raw: unknown, name: string, problems: string[], valid: (s: string) => boolean = () => true): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push(`${name}: not a list; cleared`);
    return [];
  }
  const kept = [...new Set(raw.filter((v): v is string => isString(v) && valid(v)))];
  if (kept.length !== raw.length) problems.push(`${name}: dropped bad entries`);
  return kept;
}

function sanitizeCare(raw: unknown, problems: string[]): CareData {
  if (raw !== undefined && !isObj(raw)) {
    problems.push("care: not an object; cleared");
    return { notDuplicates: [], keepUnlinked: [] };
  }
  const care = (raw ?? {}) as Obj;
  return {
    // A pair key is two ids joined by a newline.
    notDuplicates: sanitizeStrings(care["notDuplicates"], "care.notDuplicates", problems, (s) => s.split("\n").length === 2),
    keepUnlinked: sanitizeStrings(care["keepUnlinked"], "care.keepUnlinked", problems),
  };
}

/** Checks loaded data and returns a sound copy. `null` or `undefined` (no file yet) gives the defaults. */
export function sanitizeData(raw: unknown): Sanitized {
  const problems: string[] = [];
  if (raw === null || raw === undefined) return { data: defaultData(), problems };
  if (!isObj(raw)) return { data: defaultData(), problems: ["data.json: not an object; using the defaults"] };
  const folderContext: Record<string, string> = {};
  if (raw["folderContext"] !== undefined) {
    if (isObj(raw["folderContext"])) {
      for (const [folder, text] of Object.entries(raw["folderContext"])) {
        if (isString(text)) folderContext[folder] = text;
        else problems.push("folderContext: dropped a bad entry");
      }
    } else problems.push("folderContext: not an object; cleared");
  }
  const filters = raw["filters"];
  if (filters !== undefined && !isObj(filters)) problems.push("filters: not an object; cleared");
  return {
    data: {
      schema: 1,
      settings: sanitizeSettings(raw["settings"], problems),
      pins: sanitizeIdMap(raw["pins"], "pins", problems),
      hides: sanitizeIdMap(raw["hides"], "hides", problems),
      filters: { connections: sanitizeFilters(isObj(filters) ? filters["connections"] : undefined, problems) },
      folderContext,
      care: sanitizeCare(raw["care"], problems),
    },
    problems,
  };
}

/** A browser-storage number, or `fallback` when it is missing, not a finite number, or out of range. */
export function storedNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

/** A browser-storage boolean, or null when missing or not a boolean. */
export function storedBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
