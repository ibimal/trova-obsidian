// Filter evaluation. The engine runs it against its metadata table and the worker against its
// copy of Obsidian's metadata cache; both must give the same answer for the same filters.

import { basename, extname, stripExt, type LinkResolver } from "./content.js";
import { parseDay } from "./query.js";
import type { Filter, SourceMeta } from "./types.js";

const DAY_MS = 86_400_000;

export interface FilterContext {
  isOrphan?: (path: string) => boolean;
  resolveLink?: LinkResolver;
}

function toTime(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const day = parseDay(value.slice(0, 10));
    if (day !== null && value.length <= 10) return day;
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function compareScalar(actual: unknown, op: Filter["op"], expected: string | number): boolean {
  if (actual == null) return false;
  if (actual instanceof Date) actual = actual.toISOString();
  const expNum = typeof expected === "number" ? expected : null;
  const actNum =
    typeof actual === "number"
      ? actual
      : typeof actual === "string" && actual.trim() !== "" && Number.isFinite(Number(actual))
        ? Number(actual)
        : null;
  if (op === "eq" || op === "ne") {
    let equal: boolean;
    if (expNum !== null && actNum !== null) equal = expNum === actNum;
    else if (
      typeof expected === "string" &&
      parseDay(expected) !== null &&
      toTime(actual) !== null
    ) {
      const day = parseDay(expected)!;
      const t = toTime(actual)!;
      equal = t >= day && t < day + DAY_MS;
    } else equal = String(actual).trim().toLowerCase() === String(expected).trim().toLowerCase();
    return op === "eq" ? equal : !equal;
  }
  if (op === "contains")
    return String(actual).toLowerCase().includes(String(expected).toLowerCase());
  let a: number | null = actNum;
  let b: number | null = expNum;
  if (typeof expected === "string") {
    const day = parseDay(expected);
    if (day === null) return false;
    a = toTime(actual);
    // ">" means after that day ends; "<" means before it starts.
    b = op === "gt" || op === "lte" ? day + DAY_MS - 1 : day;
  }
  if (a === null || b === null) return false;
  switch (op) {
    case "lt":
      return a < b;
    case "lte":
      return a <= b;
    case "gt":
      return a > b;
    case "gte":
      return a >= b;
    default:
      return false;
  }
}

function matchOne(meta: SourceMeta, f: Filter, ctx: FilterContext): boolean {
  switch (f.field) {
    case "path":
      return meta.path.toLowerCase().includes(String(f.value).toLowerCase());
    case "ext": {
      const list = Array.isArray(f.value) ? f.value : [String(f.value)];
      return list.includes(extname(meta.path));
    }
    case "tag": {
      const wanted = (Array.isArray(f.value) ? f.value : [String(f.value)]).map((t) =>
        t.toLowerCase(),
      );
      return meta.tags.some((tag) => wanted.some((w) => tag === w || tag.startsWith(`${w}/`)));
    }
    case "modified":
    case "created": {
      const actual = f.field === "modified" ? meta.modified : meta.created;
      if (Array.isArray(f.value)) return false;
      return compareScalar(actual, f.op, f.value);
    }
    case "is":
      if (f.value === "orphan")
        return ctx.isOrphan ? ctx.isOrphan(meta.path) : meta.orphan === true;
      return false;
    case "links": {
      const target = String(f.value);
      const resolved = ctx.resolveLink?.(target, meta.path);
      if (resolved) return meta.links.includes(resolved);
      const want = stripExt(basename(target)).toLowerCase();
      return meta.links.some((l) => stripExt(basename(l)).toLowerCase() === want);
    }
    default: {
      if (!f.field.startsWith("fm.")) return false;
      const key = f.field.slice(3).toLowerCase();
      const entry = Object.entries(meta.frontmatter).find(([k]) => k.toLowerCase() === key);
      if (!entry) return f.op === "ne";
      const actual = entry[1];
      const expected = Array.isArray(f.value) ? f.value : [f.value];
      const actuals = Array.isArray(actual) ? actual : [actual];
      if (f.op === "ne")
        return expected.every((e) => actuals.every((a) => compareScalar(a, "ne", e)));
      const op = f.op === "in" ? "eq" : f.op;
      return expected.some((e) => actuals.some((a) => compareScalar(a, op, e)));
    }
  }
}

/** True when the source passes every filter. Excluded sources never pass. */
export function matchesFilters(
  meta: SourceMeta,
  filters: Filter[],
  ctx: FilterContext = {},
): boolean {
  if (meta.excluded) return false;
  for (const f of filters) {
    const ok = matchOne(meta, f, ctx);
    if (f.negate ? ok : !ok) return false;
  }
  return true;
}

/** `trova: false` in the frontmatter excludes a note everywhere. */
export function isExcludedByFrontmatter(
  frontmatter: Record<string, unknown> | null | undefined,
): boolean {
  if (!frontmatter) return false;
  const v = frontmatter["trova"];
  return v === false || v === "false";
}

/**
 * Minimal glob matcher for folder scope: supports `**`, `*` and `?`. A pattern without a wildcard
 * matches that folder and everything under it.
 */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/^\.?\//, "");
  if (!/[*?]/.test(g)) g = `${g.replace(/\/+$/, "")}{,/**}`;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!;
    if (ch === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (ch === "{" && g.startsWith("{,/**}", i)) {
      re += "(?:/.*)?";
      i += 5;
    } else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/** True when a path is inside the include globs (or there are none) and outside the exclude globs. */
export function inScope(
  path: string,
  include: string[] | undefined,
  exclude: string[] | undefined,
): boolean {
  if (exclude?.some((g) => g.trim() && globToRegExp(g).test(path))) return false;
  const inc = include?.filter((g) => g.trim()) ?? [];
  return inc.length === 0 || inc.some((g) => globToRegExp(g).test(path));
}
