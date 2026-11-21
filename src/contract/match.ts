// Text matching shared by the worker, the engine's snippet builder and in-file search.

import type { ParsedQuery, Term } from "./types.js";

/** Lower-cases without changing the string's length, so offsets stay valid. */
export function fold(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let out = "";
  for (const ch of text) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

/** A light English stemmer, so word variants match ("remapping" finds "remap"). */
export function lightStem(word: string): string {
  let w = word;
  if (w.length <= 3 || /[^a-z]/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) w = w.slice(0, -1);
  for (const suffix of ["ingly", "edly", "ing", "ed", "ly"]) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 3) {
      w = w.slice(0, -suffix.length);
      // "remapping" -> "remapp" -> "remap"
      if (w.length > 3 && w[w.length - 1] === w[w.length - 2] && !/[lsz]$/.test(w)) w = w.slice(0, -1);
      break;
    }
  }
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

const WORD_CHAR = "[\\p{L}\\p{N}_]";

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termRegExp(term: Term): RegExp | null {
  const text = fold(term.text.trim());
  if (!text) return null;
  if (term.kind === "phrase") {
    const body = text.split(/\s+/).map(escapeRe).join("\\s+");
    return new RegExp(`(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})`, "gu");
  }
  if (term.kind === "exact") return new RegExp(`(?<!${WORD_CHAR})${escapeRe(text)}(?!${WORD_CHAR})`, "gu");
  // A word matches as a prefix; its stem also matches, so variants are found.
  const stem = lightStem(text);
  const alt = stem !== text && stem.length >= 3 ? `(?:${escapeRe(text)}|${escapeRe(stem)})` : escapeRe(text);
  return new RegExp(`(?<!${WORD_CHAR})${alt}${WORD_CHAR}*`, "gu");
}

/** Character ranges where a term matches in a text. */
export function termRanges(text: string, term: Term, max = 50): [number, number][] {
  const re = termRegExp(term);
  if (!re) return [];
  const hay = fold(text);
  const out: [number, number][] = [];
  let m: RegExpExecArray | null;
  while (out.length < max && (m = re.exec(hay))) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

export function termMatches(text: string, term: Term): boolean {
  return termRanges(text, term, 1).length > 0;
}

/** All match ranges of a query's positive terms in a text, sorted and merged. */
export function queryRanges(text: string, q: ParsedQuery, max = 200): [number, number][] {
  const all: [number, number][] = [];
  for (const group of q.must) for (const t of group) all.push(...termRanges(text, t, max));
  return mergeRanges(all).slice(0, max);
}

export function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

export interface TextFields {
  title: string;
  aliases?: string[];
  headings?: string[];
  body?: string;
}

function fieldText(fields: TextFields, field: Term["field"]): string {
  const title = [fields.title, ...(fields.aliases ?? [])].join("\n");
  if (field === "title") return title;
  const headings = (fields.headings ?? []).join("\n");
  if (field === "heading") return headings;
  return `${title}\n${headings}\n${fields.body ?? ""}`;
}

/**
 * True when the fields satisfy the query's terms: every OR-group has a match, and no excluded
 * term matches. Filters are checked separately (see filters.ts).
 */
export function matchesTerms(fields: TextFields, q: ParsedQuery): boolean {
  for (const t of q.mustNot) if (termMatches(fieldText(fields, t.field), t)) return false;
  for (const group of q.must) {
    if (!group.some((t) => termMatches(fieldText(fields, t.field), t))) return false;
  }
  return true;
}

export interface Snippet {
  snippet: string;
  highlights: [number, number][];
  /** Offset in the source text where the snippet's content starts. */
  offset: number;
}

/**
 * Builds an excerpt of about `maxLen` characters around the densest group of match ranges.
 * Highlights are character ranges inside the returned snippet.
 */
export function makeSnippet(text: string, ranges: [number, number][], maxLen = 180, from = 0, to = text.length): Snippet {
  const inside = ranges.filter((r) => r[0] >= from && r[1] <= to);
  let start = from;
  if (inside.length > 0) {
    // Pick the window that holds the most matches.
    let best = 0;
    let bestCount = 0;
    for (let i = 0; i < inside.length; i++) {
      let count = 0;
      for (let j = i; j < inside.length && inside[j]![1] - inside[i]![0] <= maxLen; j++) count++;
      if (count > bestCount) {
        bestCount = count;
        best = i;
      }
    }
    start = Math.max(from, inside[best]![0] - Math.floor(maxLen / 4));
    // Start at a word boundary.
    if (start > from) {
      const space = text.lastIndexOf(" ", start);
      const nl = text.lastIndexOf("\n", start);
      const cut = Math.max(space, nl);
      if (cut >= from && start - cut < 30) start = cut + 1;
    }
  } else {
    // No match in range: skip leading whitespace and heading markers.
    const lead = /^[\s#>*-]*/.exec(text.slice(from, to));
    start = from + (lead ? lead[0].length : 0);
  }
  let end = Math.min(to, start + maxLen);
  if (end < to) {
    const space = text.lastIndexOf(" ", end);
    if (space > start + maxLen / 2) end = space;
  }
  const prefix = start > from ? "…" : "";
  const suffix = end < to ? "…" : "";
  const body = text.slice(start, end).replace(/\s/g, " ").trimEnd();
  const highlights = inside
    .filter((r) => r[0] >= start && r[1] <= end)
    .map((r): [number, number] => [r[0] - start + prefix.length, r[1] - start + prefix.length]);
  return { snippet: prefix + body + suffix, highlights, offset: start };
}

export interface LineMatch {
  line: number;
  /** Offset of the match in the whole text. */
  offset: number;
  /** The matched line with one line of context on each side. */
  context: string;
  highlights: [number, number][];
}

/** In-file search: every match inside one note, with surrounding lines. */
export function findInText(text: string, q: ParsedQuery, max = 200): LineMatch[] {
  const ranges = queryRanges(text, q, max * 4);
  if (ranges.length === 0) return [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (pos: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const out: LineMatch[] = [];
  let lastLine = -1;
  for (const r of ranges) {
    const line = lineOf(r[0]);
    if (line === lastLine) continue;
    lastLine = line;
    const from = lineStarts[Math.max(0, line - 1)]!;
    const toLine = Math.min(lineStarts.length - 1, line + 1);
    const to = toLine + 1 < lineStarts.length ? lineStarts[toLine + 1]! - 1 : text.length;
    const context = text.slice(from, to);
    const highlights = ranges.filter((x) => x[0] >= from && x[1] <= to).map((x): [number, number] => [x[0] - from, x[1] - from]);
    out.push({ line, offset: r[0], context, highlights });
    if (out.length >= max) break;
  }
  return out;
}
