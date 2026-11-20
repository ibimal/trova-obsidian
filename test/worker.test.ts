import { describe, expect, it } from "vitest";
import { parseQuery } from "@trova/contract";
import { SearchIndex } from "../src/worker/index.js";
import { fixtureDocs } from "./fixture-docs.js";

const q = (raw: string) => parseQuery(raw).query;

function makeIndex(withBodies = true): SearchIndex {
  const index = new SearchIndex();
  const { docs, bodies } = fixtureDocs();
  index.upsertMeta(docs);
  if (withBodies) index.upsertBodies(bodies);
  return index;
}

describe("worker: title lane", () => {
  const index = makeIndex(false);
  it("works on titles, aliases and headings before any body is indexed", () => {
    expect(index.search(q("kanata")).title[0]!.path).toBe("Tools/Kanata.md");
    const alias = index.search(q("KB remap")).title[0]!;
    expect(alias).toMatchObject({ path: "Tools/Kanata.md", field: "alias", alias: "KB remap" });
    const heading = index.search(q("milestones")).title[0]!;
    expect(heading).toMatchObject({ path: "Projects/Trova/Plan.md", field: "heading" });
    expect(index.search(q("kanata")).body).toEqual([]);
  });
  it("matches prefixes, ANDs words and finds files of any type by name", () => {
    expect(index.search(q("kana")).title[0]!.path).toBe("Tools/Kanata.md");
    expect(index.search(q("trova plan")).title.map((h) => h.path)).toEqual(["Projects/Trova/Plan.md"]);
    expect(index.search(q("fusion ext:pdf")).title.map((h) => h.path)).toEqual(["Papers/Fusion.pdf"]);
    expect(index.search(q("kanata")).title[0]!.titleHighlights).toEqual([[0, 6]]);
  });
});

describe("worker: body lane, filters and typo rescue", () => {
  const index = makeIndex();
  const bodyPaths = (raw: string) => index.search(q(raw)).body.map((h) => h.path);
  it("finds body text with a block and a highlighted snippet", () => {
    const hit = index.search(q("udev rule")).body[0]!;
    expect(hit.path).toBe("Tools/Kanata.md");
    expect(hit.block!.headingPath).toBe("setup/install~2");
    const [a, b] = hit.highlights[0]!;
    expect(hit.snippet.slice(a, b)).toBe("udev");
  });
  it("stems variants", () => {
    expect(bodyPaths("remappers")).toContain("Tools/Kanata.md");
  });
  it("honours phrases, exact words, exclusions and OR, like the engine", () => {
    expect(bodyPaths('"input monitoring permission"')).toEqual(["Tools/Kanata.md"]);
    expect(bodyPaths('"monitoring input permission"')).toEqual([]);
    expect(bodyPaths("=lighthous")).toEqual([]);
    expect(bodyPaths("=lighthouse")).toEqual(["NoHeadings.md"]);
    expect(bodyPaths("kanata -homebrew")).not.toContain("Tools/Kanata.md");
    expect(bodyPaths("lighthouse OR harbour").sort()).toEqual(["NoHeadings.md", "Orphan.md"]);
  });
  it("evaluates filters against the fake metadata cache", () => {
    expect(bodyPaths("kanata path:Tools")).toEqual(["Tools/Kanata.md"]);
    expect(bodyPaths("kanata tag:#keyboard")).toEqual(["Tools/Kanata.md"]);
    expect(bodyPaths("kanata links:[[Trova]]")).toEqual(["Tools/Kanata.md"]);
    expect(bodyPaths("harbour is:orphan")).toEqual(["Orphan.md"]);
    expect(bodyPaths("plan status:active rating:>3 path:Projects")).toEqual(["Projects/Trova/Plan.md"]);
    expect(index.search(q("in:title kanata")).title.map((h) => h.path)).toEqual(["Tools/Kanata.md"]);
    expect(index.search(q("tag:#tools")).title.map((h) => h.path)).toEqual(["Tools/Kanata.md"]);
  });
  it("never returns excluded notes", () => {
    expect(bodyPaths("zebrafish")).toEqual([]);
    expect(index.search(q("secret")).title).toEqual([]);
  });
  it("rescues typos only for words absent from the index", () => {
    const r = index.search(q("lighthuose"));
    expect(r.correction).toEqual({ from: "lighthuose", to: "lighthouse" });
    expect(r.body[0]).toMatchObject({ path: "NoHeadings.md", matchedBy: "fuzzy" });
    expect(index.search(q("lighthuose"), { fuzzy: 0 }).body).toEqual([]);
    expect(index.search(q("kanata")).correction).toBeUndefined();
  });
  it("finds CJK text", () => {
    expect(bodyPaths("検索エンジン")).toEqual(["Sprachen/日本語.md"]);
  });
});

describe("worker: overlay lane and updates", () => {
  it("makes a fresh edit searchable at once and limits the lane to the overlay", () => {
    const index = makeIndex();
    expect(index.search(q("wombat"), { bodies: "overlay" }).body).toEqual([]);
    index.upsertBodies([{ path: "Trova.md", body: "# Trova\nA just-typed word: wombat." }], true);
    expect(index.search(q("wombat"), { bodies: "overlay" }).body.map((h) => h.path)).toEqual(["Trova.md"]);
    expect(index.search(q("kanata"), { bodies: "overlay" }).body).toEqual([]);
    index.clearDirty(["Trova.md"]);
    expect(index.search(q("wombat"), { bodies: "overlay" }).body).toEqual([]);
    expect(index.search(q("wombat"), { bodies: "all" }).body.map((h) => h.path)).toEqual(["Trova.md"]);
  });
  it("handles rename and remove", () => {
    const index = makeIndex();
    index.rename("Orphan.md", "Moved/Island.md", "Island");
    expect(index.search(q("harbour")).body.map((h) => h.path)).toEqual(["Moved/Island.md"]);
    expect(index.search(q("island")).title.map((h) => h.path)).toEqual(["Moved/Island.md"]);
    index.remove(["Moved/Island.md"]);
    expect(index.search(q("harbour")).body).toEqual([]);
  });
});

describe("worker: vault care helpers", () => {
  const index = makeIndex();
  it("lists unlinked mentions of a title or alias, skipping notes that already link", () => {
    const found = index.mentions(["Kanata", "KB remap"], "Tools/Kanata.md");
    const mentions = found.find((m) => m.path === "Mentions.md")!;
    expect(mentions.mentions.map((m) => m.name)).toEqual(["Kanata", "KB remap"]);
    expect(found.map((m) => m.path)).not.toContain("Trova.md");
    expect(found.map((m) => m.path)).not.toContain("Tools/Kanata.md");
  });
  it("lists orphans", () => {
    const orphans = index.orphans();
    expect(orphans).toContain("Orphan.md");
    expect(orphans).not.toContain("Trova.md");
    expect(orphans).not.toContain("Secret.md");
  });
  it("suggests link targets by title and alias prefix", () => {
    expect(index.suggest("kan")[0]).toMatchObject({ path: "Tools/Kanata.md" });
    expect(index.suggest("KB re")[0]).toMatchObject({ path: "Tools/Kanata.md", alias: "KB remap" });
  });
  it("searches inside one note", () => {
    const matches = index.inFile("Tools/Kanata.md", q("install"));
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });
});
