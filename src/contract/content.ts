// Content model: ids, blocks, and the markdown facts (links, tags, frontmatter range) that
// both the engine and the plugin's worker derive from note text.

export interface Block {
  /** Heading path, such as "setup/install~2". Empty for the root block. */
  headingPath: string;
  /** Heading texts from the top level down. Empty for the root block. */
  headings: string[];
  /** Heading level 1 to 6, or 0 for the root block. */
  level: number;
  start: number;
  end: number;
}

// ---------- ids ----------

export function sourceId(collection: string, path: string): string {
  return `${collection}:${path}`;
}

export function blockId(source: string, headingPath: string): string {
  return `${source}#${headingPath}`;
}

export interface ParsedId {
  collection: string;
  path: string;
  source: string;
  /** Undefined for a source id; "" for the root block. */
  headingPath?: string;
}

export function parseId(id: string): ParsedId | null {
  const colon = id.indexOf(":");
  if (colon <= 0) return null;
  const collection = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  // A path may contain "#" only when its extension follows; split at the first "#" after the extension.
  const ext = /\.[A-Za-z0-9]+#/.exec(rest);
  const hash = ext ? ext.index + ext[0].length - 1 : /\.[A-Za-z0-9]+$/.test(rest) ? -1 : rest.indexOf("#");
  if (hash === -1) return rest ? { collection, path: rest, source: id } : null;
  const path = rest.slice(0, hash);
  if (!path) return null;
  return { collection, path, source: `${collection}:${path}`, headingPath: rest.slice(hash + 1) };
}

export function isBlockId(id: string): boolean {
  return parseId(id)?.headingPath !== undefined;
}

/** A vault's collection is named "vault-" plus the first 8 hex characters of the SHA-256 of its absolute path. */
export async function vaultCollectionName(absolutePath: string): Promise<string> {
  const bytes = new TextEncoder().encode(absolutePath);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `vault-${hex.slice(0, 8)}`;
}

export function slugHeading(text: string): string {
  return text.trim().toLowerCase().replace(/\//g, "-").replace(/\s+/g, "-");
}

// ---------- markdown structure ----------

/** The end offset of the frontmatter, including its closing line; 0 when there is none. */
export function frontmatterEnd(text: string): number {
  if (!text.startsWith("---")) return 0;
  const firstNl = text.indexOf("\n");
  if (firstNl === -1 || text.slice(0, firstNl).trim() !== "---") return 0;
  const re = /\n(---|\.\.\.)[ \t]*(\r?\n|$)/g;
  re.lastIndex = firstNl;
  const m = re.exec(text);
  return m ? m.index + m[0].length : 0;
}

/** The raw YAML of the frontmatter, without the fences; null when there is none. */
export function frontmatterText(text: string): string | null {
  const end = frontmatterEnd(text);
  if (end === 0) return null;
  const firstNl = text.indexOf("\n");
  const body = text.slice(firstNl + 1, end);
  return body.replace(/(^|\n)(---|\.\.\.)[ \t]*(\r?\n)?$/, "$1");
}

/** Character ranges of fenced code blocks, as [start, end) pairs. */
export function fencedRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /^[ \t]{0,3}(```+|~~~+)[^\n]*$/gm;
  let open: { at: number; fence: string } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const fence = m[1]!;
    if (!open) open = { at: m.index, fence };
    else if (fence[0] === open.fence[0] && fence.length >= open.fence.length) {
      out.push([open.at, m.index + m[0].length]);
      open = null;
    }
  }
  if (open) out.push([open.at, text.length]);
  return out;
}

function inRanges(pos: number, ranges: [number, number][]): boolean {
  for (const [s, e] of ranges) if (pos >= s && pos < e) return true;
  return false;
}

/** Splits a document into blocks: the text from one heading to the next heading of any level. */
export function splitBlocks(text: string): Block[] {
  const fmEnd = frontmatterEnd(text);
  const fences = fencedRanges(text);
  const blocks: Block[] = [];
  const stack: { level: number; text: string }[] = [];
  const seen = new Map<string, number>();
  const re = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
  re.lastIndex = fmEnd;
  let m: RegExpExecArray | null;
  const heads: { at: number; level: number; text: string }[] = [];
  while ((m = re.exec(text))) {
    if (inRanges(m.index, fences)) continue;
    heads.push({ at: m.index, level: m[1]!.length, text: m[2]!.trim() });
  }
  const firstAt = heads.length ? heads[0]!.at : text.length;
  if (text.slice(fmEnd, firstAt).trim() !== "" || heads.length === 0) {
    blocks.push({ headingPath: "", headings: [], level: 0, start: 0, end: firstAt });
  }
  heads.forEach((h, i) => {
    while (stack.length && stack[stack.length - 1]!.level >= h.level) stack.pop();
    stack.push({ level: h.level, text: h.text });
    const headings = stack.map((s) => s.text);
    let path = headings.map(slugHeading).join("/");
    const count = (seen.get(path) ?? 0) + 1;
    seen.set(path, count);
    if (count > 1) path = `${path}~${count}`;
    blocks.push({ headingPath: path, headings, level: h.level, start: h.at, end: i + 1 < heads.length ? heads[i + 1]!.at : text.length });
  });
  return blocks;
}

/** The block that contains a character offset. Offsets before the first block map to the first block. */
export function blockAt(blocks: Block[], offset: number): Block | undefined {
  let found = blocks[0];
  for (const b of blocks) {
    if (b.start <= offset) found = b;
    else break;
  }
  return found;
}

export function findBlock(blocks: Block[], headingPath: string): Block | undefined {
  return blocks.find((b) => b.headingPath === headingPath);
}

/** The text of a block. The root block's text excludes the frontmatter. */
export function blockText(text: string, block: Block): string {
  const start = block.level === 0 ? Math.max(block.start, frontmatterEnd(text)) : block.start;
  return text.slice(start, block.end);
}

export function countWords(text: string): number {
  const m = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return m ? m.length : 0;
}

// ---------- links and tags ----------

export interface LinkRange {
  start: number;
  end: number;
  target: string;
}

/** Wiki links and markdown links to local files, outside code. Embeds (`![[x]]`) count as links. */
export function extractLinks(text: string): LinkRange[] {
  const fences = fencedRanges(text);
  const out: LinkRange[] = [];
  const wiki = /\[\[([^\]\n]+?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wiki.exec(text))) {
    if (inRanges(m.index, fences)) continue;
    const target = m[1]!.split("|")[0]!.split("#")[0]!.trim();
    if (target) out.push({ start: m.index, end: m.index + m[0].length, target });
  }
  const md = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  while ((m = md.exec(text))) {
    if (inRanges(m.index, fences)) continue;
    let target = m[1]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
    try {
      target = decodeURIComponent(target);
    } catch {
      /* keep the raw target */
    }
    target = target.split("#")[0]!.replace(/^<|>$/g, "");
    if (target) out.push({ start: m.index, end: m.index + m[0].length, target });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Inline tags, lower-cased and without "#", outside code and frontmatter. */
export function extractInlineTags(text: string): string[] {
  const fences = fencedRanges(text);
  const fmEnd = frontmatterEnd(text);
  const out = new Set<string>();
  const re = /(^|[\s(>])#([\p{L}\p{N}_/-]+)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index < fmEnd || inRanges(m.index, fences)) continue;
    const tag = m[2]!.replace(/\/+$/, "");
    if (tag && !/^\d+$/.test(tag)) out.add(tag.toLowerCase());
  }
  return [...out];
}

export function normaliseTags(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
  return items.map((t) => String(t).trim().replace(/^#/, "").toLowerCase()).filter(Boolean);
}

export function normaliseAliases(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return items.map((a) => String(a).trim()).filter(Boolean);
}

export function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

export function extname(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export function stripExt(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? path : path.slice(0, path.length - (base.length - dot));
}

export function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** The display title of a path: its file name without the extension. */
export function titleFromPath(path: string): string {
  return stripExt(basename(path));
}

export type LinkResolver = (target: string, fromPath?: string) => string | null;

/**
 * Resolves link targets the way Obsidian does: an exact path first, then the path with ".md",
 * then the shortest path whose file name matches.
 */
export function createLinkResolver(paths: Iterable<string>): LinkResolver {
  const exact = new Map<string, string>();
  const byName = new Map<string, string>();
  const put = (key: string, path: string) => {
    const prev = byName.get(key);
    if (!prev || path.length < prev.length || (path.length === prev.length && path < prev)) byName.set(key, path);
  };
  for (const p of paths) {
    exact.set(p.toLowerCase(), p);
    put(basename(p).toLowerCase(), p);
    put(stripExt(basename(p)).toLowerCase(), p);
  }
  return (target, fromPath) => {
    let t = target.trim().replace(/\\/g, "/");
    if (t.startsWith("./") || t.startsWith("../")) {
      const parts = (fromPath ? dirname(fromPath) : "").split("/").filter(Boolean);
      for (const seg of t.split("/")) {
        if (seg === "..") parts.pop();
        else if (seg !== ".") parts.push(seg);
      }
      t = parts.join("/");
    }
    t = t.replace(/^\/+/, "");
    const key = t.toLowerCase();
    return exact.get(key) ?? exact.get(`${key}.md`) ?? byName.get(basename(key)) ?? null;
  };
}

// ---------- unlinked mentions ----------

export interface Mention {
  start: number;
  end: number;
  name: string;
}

/**
 * Finds phrase matches of a note's title or aliases in a text, skipping frontmatter, code and
 * existing links. Names shorter than `minChars` are ignored.
 */
export function findMentions(text: string, names: string[], minChars = 3): Mention[] {
  const usable = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= minChars))].sort((a, b) => b.length - a.length);
  if (usable.length === 0) return [];
  const skip: [number, number][] = [...fencedRanges(text)];
  const fmEnd = frontmatterEnd(text);
  if (fmEnd) skip.push([0, fmEnd]);
  for (const re of [/`[^`\n]+`/g, /!?\[\[[^\]\n]+\]\]/g, /!?\[[^\]\n]*\]\([^)\n]*\)/g, /<[^>\n]+>/g, /https?:\/\/\S+/g]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) skip.push([m.index, m.index + m[0].length]);
  }
  const escaped = usable.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${escaped.join("|")})(?![\\p{L}\\p{N}_])`, "giu");
  const out: Mention[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (inRanges(m.index, skip)) continue;
    out.push({ start: m.index, end: m.index + m[0].length, name: m[0] });
  }
  return out;
}
