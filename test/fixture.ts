// The fixture vault's notes: about 200 notes that cover duplicate headings, notes without
// headings, long notes, frontmatter of every type, aliases, tags, links, an excluded note, a
// canvas, a PDF and non-English text. Generation is deterministic. Copied from the trova
// repository (src/eval/fixture.ts), which also holds the evaluation queries and the code
// that writes the notes to disk for `trova eval`.

interface Topic {
  key: string;
  folder: string;
  title: string;
  terms: string[];
  question: string;
}

const TOPICS: Topic[] = [
  { key: "keyboard", folder: "Tools", title: "Keyboard", terms: ["keyboard", "remap", "layer", "homerow", "modifier", "keymap", "firmware", "chord"], question: "how do I remap modifier keys on a keyboard layer" },
  { key: "search", folder: "Search", title: "Retrieval", terms: ["retrieval", "ranking", "fusion", "bm25", "embedding", "rerank", "recall", "index"], question: "what improves ranking when combining bm25 with embedding retrieval" },
  { key: "garden", folder: "Garden", title: "Garden", terms: ["tomato", "compost", "seedling", "mulch", "prune", "harvest", "trellis", "soil"], question: "when should tomato seedlings move into compost rich soil" },
  { key: "cooking", folder: "Kitchen", title: "Cooking", terms: ["sourdough", "ferment", "starter", "hydration", "crumb", "proof", "oven", "flour"], question: "why does sourdough hydration change the crumb after the proof" },
  { key: "running", folder: "Health", title: "Running", terms: ["marathon", "tempo", "interval", "cadence", "recovery", "mileage", "taper", "stride"], question: "how should weekly mileage change during a marathon taper" },
  { key: "finance", folder: "Money", title: "Finance", terms: ["budget", "invoice", "ledger", "dividend", "expense", "forecast", "savings", "audit"], question: "which expenses belong in the quarterly budget forecast ledger" },
  { key: "astronomy", folder: "Sky", title: "Astronomy", terms: ["telescope", "nebula", "aperture", "eyepiece", "galaxy", "exposure", "tracking", "seeing"], question: "what aperture telescope shows a nebula with long exposure tracking" },
  { key: "travel", folder: "Trips", title: "Travel", terms: ["itinerary", "ferry", "hostel", "passport", "layover", "trailhead", "luggage", "visa"], question: "how to plan a ferry itinerary with a short layover and visa checks" },
];

const FILLER = ["notes", "ideas", "plan", "review", "log", "guide", "checklist", "summary", "draft", "reference", "questions", "decisions"];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sentence(topic: Topic, random: () => number, words = 14): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    out.push(random() < 0.55 ? topic.terms[Math.floor(random() * topic.terms.length)]! : FILLER[Math.floor(random() * FILLER.length)]!);
  }
  const text = out.join(" ");
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}

function paragraph(topic: Topic, random: () => number, sentences = 4): string {
  return Array.from({ length: sentences }, () => sentence(topic, random)).join(" ");
}

/** A minimal PDF with one text line per page, enough for the PDF extractor. */
function makePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  const fontId = 3 + pages.length * 2;
  pages.forEach((text, i) => {
    const escaped = text.replace(/([\\()])/g, "\\$1");
    const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
    objects[2 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    objects[3 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontId - 1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const KANATA = `---
aliases: [KB remap, Kanata tool]
tags: [tools, keyboard/software]
status: active
rating: 5
---
Kanata is a cross-platform keyboard remapper. It runs as a daemon and reads one config file.

# Setup
Before anything else, check that the keyboard is detected.

## Install
Install kanata with Homebrew and grant it input monitoring permission.

## Install
On Linux, install kanata from the release binary and add a udev rule.

# Usage
Start kanata with the config path. Layers switch with a held key. See [[Trova]] for search notes.

# Config
\`\`\`lisp
(defsrc caps a s d f)
# this hash line is code, not a heading
\`\`\`
`;

const TROVA = `---
aliases: [Trova engine]
tags: [project, search]
---
# Trova
Trova is the search engine behind Trova. It fuses keyword and vector results with reciprocal rank fusion.

## Chunk size
We decided on a chunk size of 900 tokens with 15 percent overlap after testing recall.

## Links
Related tools: [[Kanata]] and the [[Projects/Trova/Plan|plan]].
`;

const PLAN = `---
title: Trova plan
status: active
rating: 4
done: false
due: 2026-12-01
authors: [Ann, Bob]
budget: 1250.5
meta:
  owner: Bimal
  phase: 2
tags:
  - project
  - planning
---
# Plan
The plan for the Trova engine: ship the shim first, then the Rust engine. Links: [[Trova]].

## Milestones
Gate one is the Connections pane. Gate two is the CLI and MCP server.
`;

const DUP_TEXT = `The quarterly retrospective found that incremental indexing saved most of the time. We measured the scan phase, the embedding phase and the write phase on the reference vault, and the scan phase dominated on spinning disks while the embedding phase dominated on laptops. The team agreed to cache content hashes, to skip unchanged files, and to batch the writes in one transaction per hundred files so that readers never wait for a long write lock.`;

export function fixtureNotes(): Record<string, string | Buffer> {
  const files: Record<string, string | Buffer> = {};
  const random = rng(20261116);
  TOPICS.forEach((topic, t) => {
    for (let i = 0; i < 23; i++) {
      const name = `${topic.title} ${FILLER[i % FILLER.length]} ${i + 1}`;
      const path = `${topic.folder}/${name}.md`;
      const next = `${topic.title} ${FILLER[(i + 1) % FILLER.length]} ${((i + 1) % 23) + 1}`;
      const tags = `tags: [${topic.key}, area/${topic.key}]`;
      const fm = i % 3 === 0 ? `---\n${tags}\nstatus: ${i % 2 ? "active" : "done"}\nrating: ${(i % 5) + 1}\n---\n` : "";
      const headings = i % 7 === 6 ? "" : `# ${topic.terms[i % topic.terms.length]} overview\n`;
      const second = i % 7 === 6 ? "" : `\n## Details\n${paragraph(topic, random)}\n\n## Details\n${paragraph(topic, random, 2)}\n`;
      const link = i % 4 === 0 ? "" : `\nSee also [[${next}]].\n`;
      const inlineTag = i % 5 === 0 ? ` #${topic.key}` : "";
      files[path] = `${fm}${headings}${paragraph(topic, random)}${inlineTag}\n${second}${link}`;
      void t;
    }
  });

  files["Tools/Kanata.md"] = KANATA;
  files["Trova.md"] = TROVA;
  files["Projects/Trova/Plan.md"] = PLAN;
  files["NoHeadings.md"] = "This note has no headings at all. It only has a short paragraph about a lighthouse keeper and the fog signal.\n";
  files["Long.md"] = `# Long note\n${Array.from({ length: 60 }, (_, i) => `## Section ${i + 1}\n${paragraph(TOPICS[i % TOPICS.length]!, random, 5)}\n`).join("\n")}`;
  files["Secret.md"] = "---\ntrova: false\n---\n# Secret\nThe zebrafish password is hidden here and must never appear in any result.\n";
  files["Orphan.md"] = "# Orphan\nNothing links here and this note links nowhere. It describes a quiet harbour at dawn.\n";
  files["Mentions.md"] = "# Mentions\nI tried Kanata yesterday and the KB remap worked. The Trova engine found it. Not linked on purpose.\n";
  files["Dup A.md"] = `# Retrospective\n${DUP_TEXT}\n`;
  files["Dup B.md"] = `# Retro copy\n${DUP_TEXT} Small addition.\n`;
  files["Sprachen/Suchmaschinen.md"] = "# Über Suchmaschinen\nEine Suchmaschine verbindet Schlüsselwörter und Bedeutung. Die Größe der Abschnitte beeinflusst die Trefferqualität.\n";
  files["Sprachen/日本語.md"] = "# 日本語のノート\n検索エンジンはキーワードと意味を組み合わせます。東京の天気は晴れです。\n";
  files["Daily/2026-11-10.md"] = "# 2026-11-10\nWorked on the keyboard remap config and read about fusion ranking.\n";
  files["Daily/2026-11-11.md"] = "# 2026-11-11\nGarden day: compost and tomato seedlings.\n";
  files["Templates/Note.md"] = "# {{title}}\nTemplate body.\n";
  files["Board.canvas"] = JSON.stringify({
    nodes: [
      { id: "1", type: "text", text: "Canvas card about periscope design", x: 0, y: 0, width: 200, height: 100 },
      { id: "2", type: "file", file: "Tools/Kanata.md", x: 300, y: 0, width: 200, height: 100 },
    ],
    edges: [],
  });
  files["Papers/Fusion.pdf"] = makePdf(["Reciprocal rank fusion outperforms single rankers", "Second page discusses the xylophone benchmark"]);
  return files;
}
