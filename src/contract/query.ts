// The query parser. One syntax serves Instant search, Ask, saved searches, the CLI and the API.
// Grammar (see the spec, "Query language"):
//   query  = [ "?" ] [ lane ] clause { clause }
//   clause = term { "OR" term }
//   term   = [ "-" ] ( filter | phrase | exact | word )

import type { Filter, FilterOp, Lane, ParsedQuery, QueryDiagnostic, Term } from "./types.js";

export const RESERVED_KEYS = [
  "path",
  "ext",
  "tag",
  "in",
  "modified",
  "created",
  "is",
  "links",
] as const;
const LANES = ["lex", "vec", "hyde"] as const;
const DAY_MS = 86_400_000;

export interface ParseOptions {
  /** Forces the mode. Without it, a leading "?" selects "ask" and anything else "instant". */
  mode?: "instant" | "ask";
  /** The current time in ms. Relative dates resolve against it. */
  now?: number;
  /**
   * Known frontmatter keys, lower-cased. When given, `key:value` with a key outside this set and
   * outside the reserved keys is an unknown operator: it becomes plain words and gets a diagnostic.
   * When omitted, every non-reserved key is a frontmatter filter.
   */
  knownKeys?: ReadonlySet<string>;
}

export interface ParseResult {
  query: ParsedQuery;
  diagnostics: QueryDiagnostic[];
}

interface Token {
  start: number;
  end: number;
  negated: boolean;
  /** Set when the token has the form key:value with an unescaped colon. */
  key?: string;
  cmp?: string;
  /** The value of a filter, or the text of a plain token. Escapes are resolved. */
  text: string;
  quoted: boolean;
  exact: boolean;
  /** True for a bare, unquoted, unescaped upper-case OR. */
  isOr: boolean;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function tokenize(input: string, offset: number): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && isSpace(input[i]!)) i++;
    if (i >= n) break;
    const start = i;
    let negated = false;
    let exact = false;
    let escapedLead = false;
    if (input[i] === "\\" && input[i + 1] === "-") {
      escapedLead = true;
      i++;
    } else if (input[i] === "-" && i + 1 < n && !isSpace(input[i + 1]!)) {
      negated = true;
      i++;
    }
    if (
      !escapedLead &&
      input[i] === "=" &&
      i + 1 < n &&
      !isSpace(input[i + 1]!) &&
      input[i + 1] !== '"'
    ) {
      exact = true;
      i++;
    }
    let text = "";
    let key: string | undefined;
    let cmp: string | undefined;
    let quoted = false;
    let sawEscape = escapedLead;
    const readQuoted = (): string => {
      // input[i] is the opening quote
      i++;
      let out = "";
      while (i < n && input[i] !== '"') {
        if (input[i] === "\\" && input[i + 1] === '"') i++;
        out += input[i];
        i++;
      }
      if (i < n) i++; // closing quote; an unterminated phrase runs to the end
      return out;
    };
    if (input[i] === '"') {
      text = readQuoted();
      quoted = true;
    } else {
      while (i < n && !isSpace(input[i]!)) {
        const ch = input[i]!;
        if (ch === "\\" && (input[i + 1] === '"' || input[i + 1] === ":" || input[i + 1] === "-")) {
          text += input[i + 1];
          sawEscape = true;
          i += 2;
          continue;
        }
        if (
          ch === ":" &&
          key === undefined &&
          !exact &&
          KEY_RE.test(text) &&
          i + 1 < n &&
          !isSpace(input[i + 1]!)
        ) {
          // A URL such as http://x is a word, not a filter.
          if (input[i + 1] === "/" && input[i + 2] === "/") {
            text += ch;
            i++;
            continue;
          }
          key = text;
          text = "";
          i++;
          const two = input.slice(i, i + 2);
          if (two === ">=" || two === "<=") {
            cmp = two;
            i += 2;
          } else if (input[i] === ">" || input[i] === "<" || input[i] === "=") {
            cmp = input[i];
            i++;
          }
          if (input[i] === '"') {
            text = readQuoted();
            quoted = true;
            break;
          }
          if (input.startsWith("[[", i)) {
            const close = input.indexOf("]]", i);
            if (close !== -1) {
              text = input.slice(i, close + 2);
              i = close + 2;
              break;
            }
          }
          continue;
        }
        if (ch === '"' && text === "" && key === undefined) break;
        text += ch;
        i++;
      }
    }
    tokens.push({
      start: start + offset,
      end: i + offset,
      negated,
      key,
      cmp,
      text,
      quoted,
      exact,
      isOr: !negated && !exact && !quoted && !sawEscape && key === undefined && text === "OR",
    });
  }
  return tokens;
}

const CMP_OPS: Record<string, FilterOp> = {
  ">": "gt",
  "<": "lt",
  ">=": "gte",
  "<=": "lte",
  "=": "eq",
};

export function parseDay(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d.getTime();
}

function parseRelative(value: string): number | null {
  const m = /^(\d+)([dwmy])$/i.exec(value);
  if (!m) return null;
  const unit = { d: 1, w: 7, m: 30, y: 365 }[m[2]!.toLowerCase() as "d" | "w" | "m" | "y"];
  return Number(m[1]) * unit * DAY_MS;
}

function splitList(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

type FilterOutcome = { filter: Filter } | { inField: "title" | "heading" } | { bad: string };

function buildFilter(tok: Token, now: number): FilterOutcome {
  const key = tok.key!.toLowerCase();
  const value = tok.text;
  const cmpOp = tok.cmp ? CMP_OPS[tok.cmp]! : undefined;
  const negate = tok.negated ? { negate: true } : {};
  if (value === "") return { bad: `"${key}:" needs a value` };
  switch (key) {
    case "path":
      return { filter: { field: "path", op: "contains", value, ...negate } };
    case "ext": {
      const items = splitList(value).map((e) => e.replace(/^\./, "").toLowerCase());
      if (items.length === 0) return { bad: "ext: needs a file type, such as ext:pdf" };
      return { filter: { field: "ext", op: "in", value: items, ...negate } };
    }
    case "tag": {
      const items = splitList(value)
        .map((t) => t.replace(/^#/, "").toLowerCase())
        .filter(Boolean);
      if (items.length === 0) return { bad: "tag: needs a tag, such as tag:#zettel" };
      return items.length === 1
        ? { filter: { field: "tag", op: "eq", value: items[0]!, ...negate } }
        : { filter: { field: "tag", op: "in", value: items, ...negate } };
    }
    case "in": {
      const v = value.toLowerCase();
      if (v === "title" || v === "heading") return { inField: v };
      if (v === "headings") return { inField: "heading" };
      return { bad: `in: accepts "title" or "heading", not "${value}"` };
    }
    case "modified":
    case "created": {
      const rel = parseRelative(value);
      if (rel !== null && !tok.cmp)
        return { filter: { field: key, op: "gte", value: now - rel, ...negate } };
      const day = parseDay(value);
      if (day === null)
        return { bad: `"${value}" is not a date. Use YYYY-MM-DD or a span such as 7d` };
      const op = cmpOp ?? "eq";
      if (op === "eq") return { filter: { field: key, op: "eq", value, ...negate } };
      // ">" means after that day ends; "<" means before it starts.
      const ms = op === "gt" || op === "lte" ? day + DAY_MS - 1 : day;
      return { filter: { field: key, op, value: ms, ...negate } };
    }
    case "is": {
      const v = value.toLowerCase();
      if (v !== "orphan") return { bad: `is: accepts "orphan", not "${value}"` };
      return { filter: { field: "is", op: "eq", value: v, ...negate } };
    }
    case "links": {
      const target = value
        .replace(/^\[\[/, "")
        .replace(/\]\]$/, "")
        .split("|")[0]!
        .split("#")[0]!
        .trim();
      if (!target) return { bad: "links: needs a note, such as links:[[Project plan]]" };
      return { filter: { field: "links", op: "eq", value: target, ...negate } };
    }
    default: {
      const op = cmpOp ?? "eq";
      const num =
        value.trim() !== "" && !tok.quoted && Number.isFinite(Number(value)) ? Number(value) : null;
      if (op !== "eq" && num === null && parseDay(value) === null) {
        return { bad: `"${tok.cmp}" needs a number or a date, not "${value}"` };
      }
      return { filter: { field: `fm.${key}`, op, value: num ?? value, ...negate } };
    }
  }
}

function plainTerms(tok: Token): Term[] {
  if (tok.quoted) return tok.text.trim() ? [{ kind: "phrase", text: tok.text.trim() }] : [];
  if (tok.exact) return [{ kind: "exact", text: tok.text }];
  return tok.text ? [{ kind: "word", text: tok.text }] : [];
}

export function parseQuery(raw: string, opts: ParseOptions = {}): ParseResult {
  const now = opts.now ?? Date.now();
  const diagnostics: QueryDiagnostic[] = [];
  let rest = raw;
  let offset = 0;
  let mode: "instant" | "ask" = "instant";
  let lane: Lane | undefined;

  const lead = /^\s*\?/.exec(rest);
  if (lead) {
    mode = "ask";
    offset += lead[0].length;
    rest = rest.slice(lead[0].length);
  }
  const laneMatch = /^\s*(lex|vec|hyde):(?=\s|$)/i.exec(rest) ?? /^\s*(lex|vec|hyde):/i.exec(rest);
  if (laneMatch && (LANES as readonly string[]).includes(laneMatch[1]!.toLowerCase())) {
    lane = laneMatch[1]!.toLowerCase() as Lane;
    offset += laneMatch[0].length;
    rest = rest.slice(laneMatch[0].length);
  }
  if (opts.mode) mode = opts.mode;

  const tokens = tokenize(rest, offset);
  const must: Term[][] = [];
  const mustNot: Term[] = [];
  const filters: Filter[] = [];
  let inField: "title" | "heading" | undefined;
  let pendingOr = false;
  let lastWasTerm = false;

  const addTerms = (terms: Term[], negated: boolean) => {
    if (terms.length === 0) return;
    if (negated) {
      mustNot.push(...terms);
      return;
    }
    if (pendingOr && lastWasTerm && must.length > 0) must[must.length - 1]!.push(...terms);
    else for (const t of terms) must.push([t]);
    lastWasTerm = true;
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.isOr) {
      // OR joins the terms on both sides. A leading or trailing OR is a plain word.
      const next = tokens[i + 1];
      if (lastWasTerm && next && !next.isOr) {
        pendingOr = true;
        continue;
      }
      addTerms([{ kind: "word", text: "OR" }], false);
      pendingOr = false;
      continue;
    }
    if (tok.key !== undefined) {
      const key = tok.key.toLowerCase();
      const reserved = (RESERVED_KEYS as readonly string[]).includes(key);
      const known = reserved || !opts.knownKeys || opts.knownKeys.has(key);
      if (!known) {
        diagnostics.push({
          start: tok.start,
          end: tok.end,
          code: "unknown_operator",
          message: `"${tok.key}:" is not an operator or a frontmatter field. It is searched as plain words.`,
        });
        addTerms(
          [tok.key, tok.text].filter(Boolean).map((text): Term => ({ kind: "word", text })),
          tok.negated,
        );
        pendingOr = false;
        continue;
      }
      const out = buildFilter(tok, now);
      if ("bad" in out) {
        diagnostics.push({ start: tok.start, end: tok.end, code: "bad_value", message: out.bad });
      } else if ("inField" in out) {
        inField = out.inField;
      } else {
        filters.push(out.filter);
      }
      pendingOr = false;
      lastWasTerm = false;
      continue;
    }
    const wasOr = pendingOr;
    addTerms(plainTerms(tok), tok.negated);
    if (tok.negated && !wasOr) lastWasTerm = false;
    pendingOr = false;
  }

  if (inField) {
    for (const group of must) for (const t of group) t.field = inField;
  }

  const query: ParsedQuery = { mode, must, mustNot, filters, raw };
  if (lane) query.lane = lane;
  return { query, diagnostics };
}

/** The free text of a query, without filters and exclusions. The vector lane embeds this. */
export function queryText(q: ParsedQuery): string {
  return q.must
    .map((g) => g.map((t) => t.text).join(" "))
    .join(" ")
    .trim();
}

/** The number of words the user typed as search terms. */
export function queryWordCount(q: ParsedQuery): number {
  return queryText(q).split(/\s+/).filter(Boolean).length;
}

export function isEmptyQuery(q: ParsedQuery): boolean {
  return q.must.length === 0 && q.mustNot.length === 0 && q.filters.length === 0;
}

/** Returns a copy of the query with one word replaced, for typo rescue. */
export function replaceWord(q: ParsedQuery, from: string, to: string): ParsedQuery {
  return {
    ...q,
    must: q.must.map((g) =>
      g.map((t) =>
        t.kind === "word" && t.text.toLowerCase() === from.toLowerCase() ? { ...t, text: to } : t,
      ),
    ),
  };
}
