// The Context basket: notes and blocks collected from any surface, handed to an AI in one copy.

import { TFile, type App } from "obsidian";
import {
  contextTokens,
  findBlock,
  formatContext,
  frontmatterEnd,
  mergePieces,
  splitBlocks,
  titleFromPath,
  type ContextFormat,
  type ContextPiece,
} from "@trova/contract";
import type { LocalState } from "../state/store.js";

export interface BasketItem {
  /** Unique key: the path, plus "#headingPath" for a block, plus "+n" with neighbours. */
  key: string;
  path: string;
  title: string;
  kind: "note" | "block" | "neighbours";
  headingPath?: string;
  headings?: string[];
}

function isBasketItem(v: unknown): v is BasketItem {
  if (typeof v !== "object" || v === null) return false;
  const i = v as Record<string, unknown>;
  return typeof i["key"] === "string" && typeof i["path"] === "string" && typeof i["title"] === "string" && ["note", "block", "neighbours"].includes(i["kind"] as string) && (i["headingPath"] === undefined || typeof i["headingPath"] === "string") && (i["headings"] === undefined || (Array.isArray(i["headings"]) && i["headings"].every((h) => typeof h === "string")));
}

export function itemKey(path: string, headingPath?: string, neighbours = false): string {
  return headingPath === undefined ? path : `${path}#${headingPath}${neighbours ? "+n" : ""}`;
}

/** Reads the items' files asynchronously and in parallel, and merges duplicates and overlaps. */
export async function piecesFor(app: App, items: BasketItem[], onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<ContextPiece[]> {
  const texts = new Map<string, string>();
  const paths = [...new Set(items.map((i) => i.path))];
  let done = 0;
  await Promise.all(
    paths.map(async (path) => {
      const file = app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile && file.extension === "md") texts.set(path, await app.vault.cachedRead(file));
      onProgress?.(++done, paths.length);
    }),
  );
  if (signal?.aborted) return [];
  const raw: ContextPiece[] = [];
  for (const item of items) {
    const text = texts.get(item.path);
    if (text === undefined) continue;
    if (item.kind === "note" || item.headingPath === undefined) {
      raw.push({ path: item.path, title: item.title, content: text.slice(frontmatterEnd(text)) });
      continue;
    }
    const blocks = splitBlocks(text);
    const block = findBlock(blocks, item.headingPath);
    if (!block) continue;
    let start = block.level === 0 ? Math.max(block.start, frontmatterEnd(text)) : block.start;
    let end = block.end;
    let headings = block.headings;
    if (item.kind === "neighbours") {
      const at = blocks.indexOf(block);
      const first = blocks[Math.max(0, at - 1)]!;
      const last = blocks[Math.min(blocks.length - 1, at + 1)]!;
      start = first.level === 0 ? Math.max(first.start, frontmatterEnd(text)) : first.start;
      end = last.end;
      headings = first.headings;
    }
    raw.push({ path: item.path, title: item.title, headings, start, end, content: text.slice(start, end) });
  }
  return mergePieces(raw, (path) => texts.get(path));
}


export class Basket {
  items: BasketItem[];
  private listeners = new Set<() => void>();

  constructor(
    private app: App,
    private local: LocalState,
  ) {
    // Stored items are checked: a bad entry is dropped, so a damaged store never breaks the basket.
    const stored = local.get<unknown>("basket");
    this.items = Array.isArray(stored) ? stored.filter(isBasketItem) : [];
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed(): void {
    this.local.set("basket", this.items);
    for (const l of this.listeners) l();
  }

  /** Adds a note or a block. Returns false when it is already in the basket. */
  add(path: string, block?: { headingPath: string; headings: string[] }, neighbours = false): boolean {
    const key = itemKey(path, block?.headingPath, neighbours);
    if (this.items.some((i) => i.key === key)) return false;
    const item: BasketItem = { key, path, title: titleFromPath(path), kind: block ? (neighbours ? "neighbours" : "block") : "note" };
    if (block) {
      item.headingPath = block.headingPath;
      item.headings = block.headings;
    }
    this.items.push(item);
    this.changed();
    return true;
  }

  remove(key: string): BasketItem | undefined {
    const at = this.items.findIndex((i) => i.key === key);
    if (at === -1) return undefined;
    const [item] = this.items.splice(at, 1);
    this.changed();
    return item;
  }

  restore(item: BasketItem, index: number): void {
    this.items.splice(Math.min(index, this.items.length), 0, item);
    this.changed();
  }

  move(from: number, to: number): void {
    if (from === to || from < 0 || from >= this.items.length) return;
    const [item] = this.items.splice(from, 1);
    this.items.splice(Math.max(0, Math.min(this.items.length, to)), 0, item!);
    this.changed();
  }

  clear(): BasketItem[] {
    const old = this.items;
    this.items = [];
    this.changed();
    return old;
  }

  setAll(items: BasketItem[]): void {
    this.items = items;
    this.changed();
  }

  /** "Add linked notes": outgoing links one hop away. Returns the number of notes added. */
  addLinked(): number {
    let added = 0;
    for (const item of [...this.items]) {
      for (const target of Object.keys(this.app.metadataCache.resolvedLinks[item.path] ?? {})) {
        if (target.endsWith(".md") && this.add(target)) added++;
      }
    }
    return added;
  }

  pieces(onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<ContextPiece[]> {
    return piecesFor(this.app, this.items, onProgress, signal);
  }

  async assemble(format: ContextFormat, onProgress?: (done: number, total: number) => void): Promise<{ text: string; tokens: number }> {
    const pieces = await this.pieces(onProgress);
    return { text: formatContext(pieces, format), tokens: contextTokens(pieces) };
  }

  async tokens(): Promise<number> {
    return contextTokens(await this.pieces());
  }
}
