import { describe, expect, it } from "vitest";
import {
  blendRerank,
  blockAt,
  blockId,
  createLinkResolver,
  damerauLevenshtein,
  extractInlineTags,
  extractLinks,
  findInText,
  findMentions,
  formatContext,
  frontmatterEnd,
  globToRegExp,
  inScope,
  labelForCosine,
  labelForRank,
  lightStem,
  makeSnippet,
  matchesFilters,
  matchesTerms,
  mergePieces,
  ndcg,
  parseId,
  parseQuery,
  pickAskMode,
  queryRanges,
  recallAt,
  recencyMultiplier,
  rrf,
  sourceId,
  sourceScore,
  splitBlocks,
  suggestCorrections,
  typoMaxEdits,
  vaultCollectionName,
  type SourceMeta,
} from "../src/contract/index.js";

const NOW = new Date(2026, 10, 16, 12).getTime();
const p = (raw: string, extra = {}) => parseQuery(raw, { now: NOW, ...extra });

describe("query parser: every row of the Query language table", () => {
  it("words: all words must match", () => {
    expect(p("kanata remap").query.must).toEqual([[{ kind: "word", text: "kanata" }], [{ kind: "word", text: "remap" }]]);
  });
  it("quoted phrase", () => {
    expect(p('"key remapping"').query.must).toEqual([[{ kind: "phrase", text: "key remapping" }]]);
  });
  it("exclusions: -word and -\"phrase\"", () => {
    const q = p('rust -draft -"work in progress"').query;
    expect(q.must).toEqual([[{ kind: "word", text: "rust" }]]);
    expect(q.mustNot).toEqual([
      { kind: "word", text: "draft" },
      { kind: "phrase", text: "work in progress" },
    ]);
  });
  it("=word is exact", () => {
    expect(p("=rust").query.must).toEqual([[{ kind: "exact", text: "rust" }]]);
  });
  it("OR binds tighter than AND and must be upper case", () => {
    expect(p("bm25 OR splade fusion").query.must).toEqual([
      [
        { kind: "word", text: "bm25" },
        { kind: "word", text: "splade" },
      ],
      [{ kind: "word", text: "fusion" }],
    ]);
    expect(p("bm25 or splade").query.must).toHaveLength(3);
    expect(p("a OR b OR c").query.must).toEqual([[{ kind: "word", text: "a" }, { kind: "word", text: "b" }, { kind: "word", text: "c" }]]);
  });
  it("path:", () => {
    expect(p('path:"Projects/Trova"').query.filters).toEqual([{ field: "path", op: "contains", value: "Projects/Trova" }]);
  });
  it("ext: single and list", () => {
    expect(p("ext:pdf").query.filters).toEqual([{ field: "ext", op: "in", value: ["pdf"] }]);
    expect(p('ext:"png jpg"').query.filters).toEqual([{ field: "ext", op: "in", value: ["png", "jpg"] }]);
  });
  it("tag:", () => {
    expect(p("tag:#Zettel").query.filters).toEqual([{ field: "tag", op: "eq", value: "zettel" }]);
  });
  it("in: restricts terms to a field", () => {
    const q = p("in:title kanata").query;
    expect(q.must).toEqual([[{ kind: "word", text: "kanata", field: "title" }]]);
    expect(p("in:heading setup").query.must[0]![0]!.field).toBe("heading");
  });
  it("frontmatter key:value with comparisons", () => {
    expect(p("status:active").query.filters).toEqual([{ field: "fm.status", op: "eq", value: "active" }]);
    expect(p("rating:>3").query.filters).toEqual([{ field: "fm.rating", op: "gt", value: 3 }]);
    expect(p("rating:<=4.5").query.filters).toEqual([{ field: "fm.rating", op: "lte", value: 4.5 }]);
  });
  it("modified: and created: absolute and relative", () => {
    const abs = p("modified:>2026-10-01").query.filters[0]!;
    expect(abs.field).toBe("modified");
    expect(abs.op).toBe("gt");
    expect(abs.value).toBe(new Date(2026, 9, 1).getTime() + 86_400_000 - 1);
    expect(p("modified:7d").query.filters).toEqual([{ field: "modified", op: "gte", value: NOW - 7 * 86_400_000 }]);
    expect(p("created:2w").query.filters[0]!.value).toBe(NOW - 14 * 86_400_000);
    expect(p("created:2026-01-05").query.filters).toEqual([{ field: "created", op: "eq", value: "2026-01-05" }]);
  });
  it("is: and links:", () => {
    expect(p("is:orphan").query.filters).toEqual([{ field: "is", op: "eq", value: "orphan" }]);
    expect(p("links:[[Trova]]").query.filters).toEqual([{ field: "links", op: "eq", value: "Trova" }]);
    expect(p("links:[[My Note|alias]] x").query.filters).toEqual([{ field: "links", op: "eq", value: "My Note" }]);
  });
  it("lane prefixes only as the first token", () => {
    const q = p("vec: how retrieval fusion works").query;
    expect(q.lane).toBe("vec");
    expect(q.must).toHaveLength(4);
    expect(p("lex:kanata").query.lane).toBe("lex");
    expect(p("hyde: a note about remapping").query.lane).toBe("hyde");
  });
  it("? prefix sends to Ask", () => {
    const q = p("? what did I decide about chunk size").query;
    expect(q.mode).toBe("ask");
    expect(q.must[0]![0]!.text).toBe("what");
    expect(p("kanata").query.mode).toBe("instant");
  });
  it("negated filters and filters combined with AND", () => {
    const q = p("-tag:draft path:Projects kanata").query;
    expect(q.filters).toEqual([
      { field: "tag", op: "eq", value: "draft", negate: true },
      { field: "path", op: "contains", value: "Projects" },
    ]);
    expect(q.must).toHaveLength(1);
  });
  it("operator keys are case-insensitive", () => {
    expect(p("PATH:foo Tag:x").query.filters.map((f) => f.field)).toEqual(["path", "tag"]);
  });
  it("backslash escapes quote, colon and a leading dash", () => {
    expect(p("\\-draft").query.must).toEqual([[{ kind: "word", text: "-draft" }]]);
    expect(p("foo\\:bar").query.must).toEqual([[{ kind: "word", text: "foo:bar" }]]);
    expect(p('"say \\"hi\\""').query.must).toEqual([[{ kind: "phrase", text: 'say "hi"' }]]);
  });
});

describe("query parser: malformed input", () => {
  it("unknown operators become plain words and are underlined", () => {
    const r = p("foo:bar kanata", { knownKeys: new Set(["status"]) });
    expect(r.query.must.map((g) => g[0]!.text)).toEqual(["foo", "bar", "kanata"]);
    expect(r.query.filters).toEqual([]);
    expect(r.diagnostics).toEqual([expect.objectContaining({ start: 0, end: 7, code: "unknown_operator" })]);
    expect(p("status:done", { knownKeys: new Set(["status"]) }).diagnostics).toEqual([]);
  });
  it("bad filter values are underlined and the rest still runs", () => {
    const r = p("is:banana modified:yesterday in:body kanata");
    expect(r.diagnostics.map((d) => d.code)).toEqual(["bad_value", "bad_value", "bad_value"]);
    expect(r.query.filters).toEqual([]);
    expect(r.query.must).toEqual([[{ kind: "word", text: "kanata" }]]);
    expect(p("modified:2026-13-40").diagnostics).toHaveLength(1);
  });
  it("handles empty, whitespace, lone operators and unterminated phrases", () => {
    expect(p("").query.must).toEqual([]);
    expect(p("   ").query.must).toEqual([]);
    expect(p("OR").query.must).toEqual([[{ kind: "word", text: "OR" }]]);
    expect(p("a OR").query.must).toHaveLength(2);
    expect(p('"unterminated phrase').query.must).toEqual([[{ kind: "phrase", text: "unterminated phrase" }]]);
    expect(p("-").query.must).toEqual([[{ kind: "word", text: "-" }]]);
    expect(p("https://example.com/x").query.filters).toEqual([]);
    expect(p("?").query.mode).toBe("ask");
  });
});

describe("ranking", () => {
  it("RRF: score = sum of weight / (60 + rank)", () => {
    const fused = rrf([
      { weight: 2, items: ["a", "b"] },
      { weight: 1, items: ["b", "c"] },
    ]);
    expect(fused.map((f) => f.id)).toEqual(["b", "a", "c"]);
    expect(fused[0]!.score).toBeCloseTo(2 / 62 + 1 / 61);
    expect(fused[1]!.score).toBeCloseTo(2 / 61);
  });
  it("recency multiplier", () => {
    expect(recencyMultiplier(0)).toBeCloseTo(1.1);
    expect(recencyMultiplier(30)).toBeCloseTo(1 + 0.1 / Math.E);
    expect(recencyMultiplier(null)).toBe(1);
  });
  it("labels from cosine and from rank", () => {
    expect(labelForCosine(0.6)).toBe("strong");
    expect(labelForCosine(0.59)).toBe("related");
    expect(labelForCosine(0.45)).toBe("related");
    expect(labelForCosine(0.3)).toBe("loose");
    expect(labelForCosine(0.29)).toBeNull();
    expect([1, 3, 4, 10, 11].map(labelForRank)).toEqual(["strong", "strong", "related", "related", "loose"]);
  });
  it("source score: best block plus capped bonus", () => {
    expect(sourceScore([0.7])).toBeCloseTo(0.7);
    expect(sourceScore([0.7, 0.5, 0.4])).toBeCloseTo(0.75);
    expect(sourceScore([0.7, 0.5, 0.5, 0.5, 0.5, 0.5])).toBeCloseTo(0.85);
  });
  it("Auto mode picks Deep for long or question-shaped queries", () => {
    expect(pickAskMode("kanata remap")).toBe("fast");
    expect(pickAskMode("one two three four five six")).toBe("deep");
    expect(pickAskMode("chunk size?")).toBe("deep");
    expect(pickAskMode("how fusion works")).toBe("deep");
    expect(pickAskMode(parseQuery("? why rerank").query)).toBe("deep");
    // Short questions that start with an auxiliary verb run Deep too.
    for (const q of ["should I taper early", "do seedlings need light", "are tomatoes perennial", "will it frost", "could mulch help", "would compost burn", "has it rained", "have I pruned", "was it sown", "were they planted"]) expect(pickAskMode(q)).toBe("deep");
    expect(pickAskMode("tomato soil mix")).toBe("fast");
  });
  it("position-aware blend", () => {
    expect(blendRerank(1, 1, 0)).toBeCloseTo(0.75);
    expect(blendRerank(5, 1, 0)).toBeCloseTo(0.6);
    expect(blendRerank(11, 1, 0)).toBeCloseTo(0.4);
  });
  it("Damerau-Levenshtein counts a transposition as one edit", () => {
    expect(damerauLevenshtein("kanta", "kanata")).toBe(1);
    expect(damerauLevenshtein("knaata", "kanata")).toBe(1);
    expect(damerauLevenshtein("abc", "abc")).toBe(0);
    expect(damerauLevenshtein("abcdef", "uvwxyz", 2)).toBe(3);
  });
  it("typo rescue rules", () => {
    expect(typoMaxEdits("rust")).toBe(0);
    expect(typoMaxEdits("kanta")).toBe(1);
    expect(typoMaxEdits("retreival")).toBe(2);
    expect(typoMaxEdits("日本語のテキスト")).toBe(0);
    expect(typoMaxEdits("kanta", 0)).toBe(0);
    const vocab = [
      { term: "kanata", docs: 14 },
      { term: "manta", docs: 2 },
      { term: "santa", docs: 30 },
    ];
    expect(suggestCorrections("kanta", vocab)[0]).toEqual({ term: "santa", docs: 30, distance: 1 });
    expect(suggestCorrections("kanta", vocab.slice(0, 2))[0]!.term).toBe("kanata");
  });
  it("nDCG and recall", () => {
    expect(ndcg(["a", "b"], { a: 3, b: 1 })).toBeCloseTo(1);
    expect(ndcg(["b", "a"], { a: 3, b: 1 })).toBeLessThan(1);
    expect(recallAt(["a", "x"], { a: 1, b: 1 })).toBe(0.5);
  });
});

const DOC = `---
aliases: [KB remap]
---
Intro text before any heading.

# Setup
Setup body.

## Install
Install kanata with Homebrew.

\`\`\`sh
# not a heading
\`\`\`

## Install
Second install section.

# Usage
Use it.
`;

describe("content model", () => {
  it("builds source and block ids", async () => {
    const src = sourceId("vault-3fa9c2d1", "Tools/Kanata.md");
    expect(blockId(src, "setup/install")).toBe("vault-3fa9c2d1:Tools/Kanata.md#setup/install");
    expect(parseId("vault-3fa9c2d1:Tools/Kanata.md#setup/install~2")).toEqual({
      collection: "vault-3fa9c2d1",
      path: "Tools/Kanata.md",
      source: src,
      headingPath: "setup/install~2",
    });
    expect(parseId(`${src}#`)!.headingPath).toBe("");
    expect(parseId(src)!.headingPath).toBeUndefined();
    expect(parseId("vault-1:C#/notes.md")!.path).toBe("C#/notes.md");
    expect(await vaultCollectionName("/Users/me/Vault")).toMatch(/^vault-[0-9a-f]{8}$/);
    expect(await vaultCollectionName("/Users/me/Vault")).toBe(await vaultCollectionName("/Users/me/Vault"));
  });
  it("splits blocks, numbers repeated paths and ignores headings in code", () => {
    const blocks = splitBlocks(DOC);
    expect(blocks.map((b) => b.headingPath)).toEqual(["", "setup", "setup/install", "setup/install~2", "usage"]);
    expect(blocks[2]!.headings).toEqual(["Setup", "Install"]);
    expect(DOC.slice(blocks[2]!.start, blocks[2]!.end)).toContain("not a heading");
    expect(blocks[blocks.length - 1]!.end).toBe(DOC.length);
    expect(blockAt(blocks, DOC.indexOf("Homebrew"))!.headingPath).toBe("setup/install");
    expect(blockAt(blocks, 2)!.headingPath).toBe("");
  });
  it("a note without headings is one root block; a note starting with a heading has no root block", () => {
    expect(splitBlocks("just text")).toEqual([{ headingPath: "", headings: [], level: 0, start: 0, end: 9 }]);
    expect(splitBlocks("# A\nx").map((b) => b.headingPath)).toEqual(["a"]);
  });
  it("finds frontmatter, links and tags", () => {
    expect(frontmatterEnd(DOC)).toBe(DOC.indexOf("Intro"));
    expect(frontmatterEnd("no frontmatter")).toBe(0);
    const text = "See [[Trova|the engine]] and [[Folder/Note#Heading]] and [md](Other%20Note.md) and [web](https://x.y).\n```\n[[code]]\n```";
    expect(extractLinks(text).map((l) => l.target)).toEqual(["Trova", "Folder/Note", "Other Note.md"]);
    expect(extractInlineTags("a #Zettel/sub b #123 c\n```\n#code\n```").sort()).toEqual(["zettel/sub"]);
  });
  it("resolves links like Obsidian", () => {
    const resolve = createLinkResolver(["Tools/Kanata.md", "Trova.md", "deep/folder/Trova.md", "img/pic.png"]);
    expect(resolve("Kanata")).toBe("Tools/Kanata.md");
    expect(resolve("Trova")).toBe("Trova.md");
    expect(resolve("deep/folder/Trova")).toBe("deep/folder/Trova.md");
    expect(resolve("pic.png")).toBe("img/pic.png");
    expect(resolve("Missing")).toBeNull();
  });
  it("unlinked mentions skip code, links and short names", () => {
    const text = "Kanata is great. See [[Kanata]] and `kanata` and kanatas.\n```\nkanata\n```\nAlso KB remap here.";
    const found = findMentions(text, ["Kanata", "KB remap", "ab"]);
    expect(found.map((m) => m.name)).toEqual(["Kanata", "KB remap"]);
    expect(found[0]!.start).toBe(0);
  });
});

const meta = (over: Partial<SourceMeta> = {}): SourceMeta => ({
  path: "Projects/Trova/Plan.md",
  title: "Plan",
  aliases: [],
  tags: ["zettel/idea", "project"],
  links: ["Trova.md"],
  frontmatter: { status: "active", rating: 4, authors: ["Ann", "Bob"], due: "2026-11-20" },
  created: new Date(2026, 9, 1, 9).getTime(),
  modified: new Date(2026, 10, 15, 9).getTime(),
  wordCount: 100,
  excluded: false,
  ...over,
});
const f = (raw: string) => p(raw).query.filters;

describe("filters", () => {
  it("path, ext, tag (nested), frontmatter", () => {
    expect(matchesFilters(meta(), f('path:"projects/trova"'))).toBe(true);
    expect(matchesFilters(meta(), f("ext:md"))).toBe(true);
    expect(matchesFilters(meta(), f("ext:pdf"))).toBe(false);
    expect(matchesFilters(meta(), f("tag:#zettel"))).toBe(true);
    expect(matchesFilters(meta(), f("tag:zet"))).toBe(false);
    expect(matchesFilters(meta(), f("status:Active rating:>3"))).toBe(true);
    expect(matchesFilters(meta(), f("rating:>4"))).toBe(false);
    expect(matchesFilters(meta(), f("rating:=4"))).toBe(true);
    expect(matchesFilters(meta(), f("authors:bob"))).toBe(true);
    expect(matchesFilters(meta(), f("due:<2026-12-01"))).toBe(true);
    expect(matchesFilters(meta(), f("missing:x"))).toBe(false);
    expect(matchesFilters(meta(), f("-status:done -tag:draft"))).toBe(true);
    expect(matchesFilters(meta(), f("-tag:project"))).toBe(false);
  });
  it("dates", () => {
    expect(matchesFilters(meta(), f("modified:7d"))).toBe(true);
    expect(matchesFilters(meta(), f("created:7d"))).toBe(false);
    expect(matchesFilters(meta(), f("modified:2026-11-15"))).toBe(true);
    expect(matchesFilters(meta(), f("modified:>2026-11-15"))).toBe(false);
    expect(matchesFilters(meta(), f("modified:>=2026-11-15"))).toBe(true);
    expect(matchesFilters(meta(), f("created:<2026-10-02"))).toBe(true);
  });
  it("graph filters and exclusion", () => {
    const resolveLink = createLinkResolver(["Trova.md", "Other.md"]);
    expect(matchesFilters(meta(), f("links:[[Trova]]"), { resolveLink })).toBe(true);
    expect(matchesFilters(meta(), f("links:[[Other]]"), { resolveLink })).toBe(false);
    expect(matchesFilters(meta(), f("is:orphan"), { isOrphan: () => true })).toBe(true);
    expect(matchesFilters(meta(), f("is:orphan"), { isOrphan: () => false })).toBe(false);
    expect(matchesFilters(meta({ excluded: true }), [])).toBe(false);
  });
  it("scope globs", () => {
    expect(globToRegExp("Templates").test("Templates/Daily.md")).toBe(true);
    expect(globToRegExp("Templates").test("Templates2/x.md")).toBe(false);
    expect(globToRegExp("**/*.pdf").test("a/b/c.pdf")).toBe(true);
    expect(globToRegExp("**/*.pdf").test("c.pdf")).toBe(true);
    expect(inScope("Daily/2026.md", [], ["Daily"])).toBe(false);
    expect(inScope("Notes/a.md", ["Notes/**"], [])).toBe(true);
    expect(inScope("Other/a.md", ["Notes/**"], [])).toBe(false);
  });
});

describe("text matching", () => {
  it("stems variants and matches prefixes", () => {
    expect(lightStem("remapping")).toBe("remap");
    expect(lightStem("notes")).toBe("note");
    const q = p("remap").query;
    expect(queryRanges("Key remapping with kanata", q)).toEqual([[4, 13]]);
    expect(matchesTerms({ title: "Kanata", body: "remaps keys" }, p("kan remapping").query)).toBe(true);
  });
  it("phrases and exact words do not prefix-match", () => {
    expect(matchesTerms({ title: "x", body: "rusty nail" }, p("=rust").query)).toBe(false);
    expect(matchesTerms({ title: "x", body: "rust nail" }, p("=rust").query)).toBe(true);
    expect(matchesTerms({ title: "x", body: "key  remapping tool" }, p('"key remapping"').query)).toBe(true);
    expect(matchesTerms({ title: "x", body: "keys remapping" }, p('"key remapping"').query)).toBe(false);
  });
  it("exclusions, OR and field restriction", () => {
    expect(matchesTerms({ title: "a", body: "rust draft" }, p("rust -draft").query)).toBe(false);
    expect(matchesTerms({ title: "a", body: "splade" }, p("bm25 OR splade").query)).toBe(true);
    expect(matchesTerms({ title: "Other", body: "kanata" }, p("in:title kanata").query)).toBe(false);
    expect(matchesTerms({ title: "Other", headings: ["Kanata setup"] }, p("in:heading kanata").query)).toBe(true);
  });
  it("builds a snippet with highlights inside it", () => {
    const text = `${"lorem ipsum ".repeat(40)}Install kanata with Homebrew and ${"dolor sit ".repeat(40)}`;
    const ranges = queryRanges(text, p("kanata").query);
    const s = makeSnippet(text, ranges, 80);
    expect(s.snippet.startsWith("…")).toBe(true);
    expect(s.highlights).toHaveLength(1);
    const [a, b] = s.highlights[0]!;
    expect(s.snippet.slice(a, b)).toBe("kanata");
  });
  it("in-file search lists matches with context lines", () => {
    const text = "line one\nkanata here\nline three\nmore\nKanata again";
    const found = findInText(text, p("kanata").query);
    expect(found.map((m) => m.line)).toEqual([1, 4]);
    expect(found[0]!.context).toBe("line one\nkanata here\nline three");
    const [a, b] = found[0]!.highlights[0]!;
    expect(found[0]!.context.slice(a, b)).toBe("kanata");
  });
});

describe("context basket", () => {
  const pieces = [
    { path: "Tools/Kanata.md", title: "Kanata", headings: ["Setup", "Install"], start: 10, end: 30, content: "## Install\nbrew install" },
    { path: "Trova.md", title: "Trova", content: "Whole note." },
  ];
  it("matches the golden output for each format", () => {
    expect(formatContext(pieces, "markdown")).toBe("## [[Tools/Kanata#Install]]\n\n## Install\nbrew install\n\n## [[Trova]]\n\nWhole note.\n");
    expect(formatContext(pieces, "xml")).toBe(
      '<documents>\n<document path="Tools/Kanata.md" heading="Setup &gt; Install">\n## Install\nbrew install\n</document>\n<document path="Trova.md">\nWhole note.\n</document>\n</documents>\n',
    );
    expect(formatContext(pieces, "plain")).toBe("## Install\nbrew install\n\nWhole note.\n");
  });
  it("merges duplicates and overlaps, and a whole note absorbs its blocks", () => {
    const text = "0123456789abcdefghij";
    const merged = mergePieces(
      [
        { path: "a.md", title: "a", start: 0, end: 8, content: text.slice(0, 8) },
        { path: "a.md", title: "a", start: 5, end: 12, content: text.slice(5, 12) },
        { path: "a.md", title: "a", start: 0, end: 8, content: text.slice(0, 8) },
        { path: "b.md", title: "b", start: 0, end: 3, content: "xyz" },
        { path: "b.md", title: "b", content: "whole b" },
      ],
      (path) => (path === "a.md" ? text : undefined),
    );
    expect(merged).toEqual([
      { path: "a.md", title: "a", start: 0, end: 12, content: text.slice(0, 12), headings: undefined },
      { path: "b.md", title: "b", content: "whole b" },
    ]);
  });
});
