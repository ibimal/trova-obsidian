import { createLinkResolver, extractInlineTags, extractLinks, frontmatterEnd, splitBlocks, titleFromPath } from "@trova/contract";
import { fixtureNotes } from "../../eval/src/fixture.js";
import type { WorkerDoc } from "../src/worker/index.js";

/** A fake metadata cache built from the fixture vault. */
export function fixtureDocs(): { docs: WorkerDoc[]; bodies: { path: string; body: string }[] } {
  const notes = fixtureNotes();
  const paths = Object.keys(notes);
  const resolve = createLinkResolver(paths);
  const docs: WorkerDoc[] = [];
  const bodies: { path: string; body: string }[] = [];
  for (const [path, content] of Object.entries(notes)) {
    const text = typeof content === "string" && path.endsWith(".md") ? content : "";
    const fm = text.slice(0, frontmatterEnd(text));
    const list = (key: string) => (new RegExp(`^${key}: \\[(.*)\\]$`, "m").exec(fm)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const scalar = (key: string) => new RegExp(`^${key}: (.+)$`, "m").exec(fm)?.[1];
    const frontmatter: Record<string, unknown> = {};
    for (const key of ["status", "rating"]) if (scalar(key)) frontmatter[key] = key === "rating" ? Number(scalar(key)) : scalar(key);
    docs.push({
      path,
      title: titleFromPath(path),
      aliases: list("aliases"),
      tags: [...new Set([...list("tags").map((t) => t.toLowerCase()), ...extractInlineTags(text)])],
      links: [...new Set(extractLinks(text).map((l) => resolve(l.target, path)).filter((l): l is string => !!l && l !== path))],
      frontmatter,
      created: 1,
      modified: 1000 + docs.length,
      wordCount: text.split(/\s+/).length,
      excluded: /^trova: false$/m.test(fm) || path.startsWith("Templates/"),
      headings: splitBlocks(text).filter((b) => b.level > 0).map((b) => ({ text: b.headings[b.headings.length - 1]!, level: b.level, offset: b.start })),
    });
    if (text) bodies.push({ path, body: text });
  }
  return { docs, bodies };
}

