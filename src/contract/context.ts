// Context basket: merging of overlapping items and the three text output formats.

import { estimateTokens } from "./ranking.js";

export type ContextFormat = "markdown" | "xml" | "plain" | "note";

/** One piece of content handed to an AI: a whole note, or a character range of one. */
export interface ContextPiece {
  path: string;
  title: string;
  /** Heading texts of the block; empty or absent for a whole note or the root block. */
  headings?: string[];
  /** Character range in the note; absent for a whole note. */
  start?: number;
  end?: number;
  content: string;
}

/**
 * Merges duplicates and overlaps while keeping basket order: a whole note absorbs its blocks, and
 * overlapping or touching ranges of one note join into one piece. `fullText` returns a note's
 * text, which is needed to join two ranges.
 */
export function mergePieces(
  pieces: ContextPiece[],
  fullText: (path: string) => string | undefined,
): ContextPiece[] {
  const whole = new Set(pieces.filter((p) => p.start === undefined).map((p) => p.path));
  const out: ContextPiece[] = [];
  for (const p of pieces) {
    if (p.start === undefined) {
      if (!out.some((o) => o.path === p.path && o.start === undefined)) out.push({ ...p });
      continue;
    }
    if (whole.has(p.path)) continue;
    const overlap = out.find(
      (o) => o.path === p.path && o.start !== undefined && p.start! <= o.end! && p.end! >= o.start,
    );
    if (!overlap) {
      out.push({ ...p });
      continue;
    }
    const start = Math.min(overlap.start!, p.start);
    const end = Math.max(overlap.end!, p.end!);
    if (start === overlap.start && end === overlap.end) continue;
    const text = fullText(p.path);
    overlap.content = text
      ? text.slice(start, end)
      : overlap.start! <= p.start
        ? overlap.content + p.content
        : p.content + overlap.content;
    if (p.start < overlap.start!) overlap.headings = p.headings;
    overlap.start = start;
    overlap.end = end;
  }
  return out;
}

function linkFor(piece: ContextPiece): string {
  const name = piece.path.replace(/\.md$/i, "");
  const heading = piece.headings?.length ? `#${piece.headings[piece.headings.length - 1]}` : "";
  return `[[${name}${heading}]]`;
}

function xmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatContext(pieces: ContextPiece[], format: ContextFormat): string {
  const body = (p: ContextPiece) => p.content.trim();
  switch (format) {
    case "markdown":
    case "note":
      return (
        pieces.map((p) => `## ${linkFor(p)}\n\n${body(p)}`).join("\n\n") +
        (pieces.length ? "\n" : "")
      );
    case "xml":
      return (
        "<documents>\n" +
        pieces
          .map((p) => {
            const heading = p.headings?.length
              ? ` heading="${xmlAttr(p.headings.join(" > "))}"`
              : "";
            return `<document path="${xmlAttr(p.path)}"${heading}>\n${body(p)}\n</document>`;
          })
          .join("\n") +
        "\n</documents>\n"
      );
    case "plain":
      return pieces.map(body).join("\n\n") + (pieces.length ? "\n" : "");
  }
}

export function contextTokens(pieces: ContextPiece[]): number {
  return pieces.reduce((sum, p) => sum + estimateTokens(p.content), 0);
}
