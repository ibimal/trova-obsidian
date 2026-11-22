// Every ranking number is a named constant here, so the evaluation set can tune it.

import type { Label, ParsedQuery } from "./types.js";
import { queryText } from "./query.js";

// ---------- Instant search ----------
export const RRF_K = 60;
export const TITLE_LANE_WEIGHT = 2;
export const OTHER_LANE_WEIGHT = 1;
export const RECENCY_BOOST = 0.1;
export const RECENCY_HALF_LIFE_DAYS = 30;
export const TYPO_RESCUE_MAX_RESULTS = 3;
export const TYPO_MIN_WORD_LENGTH = 5;
export const TYPO_TWO_EDITS_MIN_LENGTH = 9;
export const SEMANTIC_ROWS_DELAY_MS = 150;
export const SEMANTIC_ROWS_MIN_WORDS = 3;
export const SEMANTIC_ROWS_MAX = 5;
export const QMD_BM25_WEIGHTS = { path: 1.5, title: 4.0, body: 1.0 } as const;

// ---------- Connections ----------
export const RELATED_NEAREST_CHUNKS = 100;
export const EXTRA_BLOCK_BONUS = 0.05;
export const EXTRA_BLOCK_BONUS_CAP = 0.15;
export const MIN_ANCHOR_WORDS = 20;

export interface LabelThresholds {
  strong: number;
  related: number;
  loose: number;
}
export const DEFAULT_THRESHOLDS: LabelThresholds = { strong: 0.6, related: 0.45, loose: 0.3 };
/** Thresholds per embedding model id. Models not listed use the defaults. */
export const MODEL_THRESHOLDS: Record<string, LabelThresholds> = {
  "embeddinggemma-300M": DEFAULT_THRESHOLDS,
};

// ---------- Ask ----------
export const ASK_LANE_LIMIT = 50;
export const ASK_FAST_LIMIT = 20;
export const ASK_RERANK_TOP = 30;
export const ASK_DEEP_MIN_WORDS = 6;
export const ASK_DEEP_DEADLINE_MS = 5000;
/** Auto runs Deep for input that starts with one of these, as a short question usually does. */
export const ASK_QUESTION_WORDS = ["who", "what", "when", "where", "why", "how", "which", "does", "do", "is", "are", "was", "were", "can", "could", "should", "would", "will", "has", "have"];
export const ASK_STRONG_RANKS = 3;
export const ASK_RELATED_RANKS = 10;
/** Ask relaxes an all-words keyword query to any-word when it finds fewer hits than this. */
export const ASK_RELAX_BELOW = 3;
export const ASK_STOPWORDS = new Set(
  "a about an and are as at be been but by can did do does for from had has have how i if in into is it its me my of on or our should so than that the their them then there these they this to was we were what when where which who why will with would you your".split(
    " ",
  ),
);
export const BLEND_ALPHA = { top3: 0.75, top10: 0.6, rest: 0.4 } as const;

// ---------- Vault care ----------
export const LINK_SUGGEST_TITLE_WEIGHT = 0.5;
export const LINK_SUGGEST_SIMILARITY_WEIGHT = 0.5;
export const DUPLICATE_BLOCK_COSINE = 0.92;
export const DUPLICATE_BLOCK_MIN_WORDS = 40;
export const DUPLICATE_SOURCE_COSINE = 0.95;
export const ORPHAN_SUGGESTIONS = 3;
export const REDISCOVER_RECENT_DAYS = 7;
export const REDISCOVER_STALE_DAYS = 90;
export const REDISCOVER_PER_DAY = 5;

// ---------- Limits ----------
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export interface RankedList<T> {
  weight: number;
  items: T[];
}

/**
 * Reciprocal Rank Fusion: score = Σ weight / (k + rank), ranks starting at 1.
 * Returns ids ordered by fused score, with the score.
 */
export function rrf(lists: RankedList<string>[], k = RRF_K): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.items.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + list.weight / (k + i + 1));
    });
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}

/** Multiplier for a note opened `days` days ago. A note never opened gets 1. */
export function recencyMultiplier(daysSinceOpened: number | null | undefined): number {
  if (daysSinceOpened == null || !Number.isFinite(daysSinceOpened)) return 1;
  return 1 + RECENCY_BOOST * Math.exp(-Math.max(0, daysSinceOpened) / RECENCY_HALF_LIFE_DAYS);
}

export function thresholdsFor(modelId?: string): LabelThresholds {
  return (modelId && MODEL_THRESHOLDS[modelId]) || DEFAULT_THRESHOLDS;
}

/** Maps a cosine similarity to a label. Returns null below the Loose threshold. */
export function labelForCosine(cosine: number, t: LabelThresholds = DEFAULT_THRESHOLDS): Label | null {
  if (cosine >= t.strong) return "strong";
  if (cosine >= t.related) return "related";
  if (cosine >= t.loose) return "loose";
  return null;
}

/** Ask results are labelled by rank (starting at 1): top 3 Strong, next 7 Related, the rest Loose. */
export function labelForRank(rank: number): Label {
  if (rank <= ASK_STRONG_RANKS) return "strong";
  if (rank <= ASK_RELATED_RANKS) return "related";
  return "loose";
}

/** A source's score: its best block, plus a bonus for each further block above the Related threshold. */
export function sourceScore(blockScores: number[], t: LabelThresholds = DEFAULT_THRESHOLDS): number {
  if (blockScores.length === 0) return 0;
  const sorted = [...blockScores].sort((a, b) => b - a);
  const extra = sorted.slice(1).filter((s) => s >= t.related).length;
  return sorted[0]! + Math.min(EXTRA_BLOCK_BONUS_CAP, extra * EXTRA_BLOCK_BONUS);
}

/** Auto mode: Deep for long or question-shaped queries, Fast otherwise. */
export function pickAskMode(q: ParsedQuery | string): "fast" | "deep" {
  const text = (typeof q === "string" ? q : queryText(q)).trim();
  const raw = (typeof q === "string" ? q : q.raw).trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length >= ASK_DEEP_MIN_WORDS) return "deep";
  if (raw.endsWith("?")) return "deep";
  const first = (words[0] ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (ASK_QUESTION_WORDS.includes(first)) return "deep";
  return "fast";
}

/** qmd's position-aware blend of the fused rank and the rerank score. `fusedRank` starts at 1. */
export function blendRerank(fusedRank: number, rrfNormalised: number, rerankScore: number): number {
  const alpha = fusedRank <= 3 ? BLEND_ALPHA.top3 : fusedRank <= 10 ? BLEND_ALPHA.top10 : BLEND_ALPHA.rest;
  return alpha * rrfNormalised + (1 - alpha) * rerankScore;
}

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;
export function hasCjk(text: string): boolean {
  return CJK_RE.test(text);
}

/** Maximum edits typo rescue allows for a word, or 0 when the word is never corrected. */
export function typoMaxEdits(word: string, userMax: 0 | 1 | 2 = 1): number {
  if (userMax === 0 || hasCjk(word)) return 0;
  const len = [...word].length;
  if (len < TYPO_MIN_WORD_LENGTH) return 0;
  if (len >= TYPO_TWO_EDITS_MIN_LENGTH) return 2;
  return userMax === 2 ? 2 : 1;
}

/**
 * Damerau-Levenshtein distance (optimal string alignment). Returns `max + 1` as soon as the
 * distance is known to exceed `max`.
 */
export function damerauLevenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (la === 0) return lb;
  if (lb === 0) return la;
  let prev2: number[] = [];
  let prev = Array.from({ length: lb + 1 }, (_, j) => j);
  for (let i = 1; i <= la; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[lb]!;
}

export interface VocabEntry {
  term: string;
  docs: number;
}

/**
 * Picks the correction for a misspelt word: the vocabulary word within the allowed edit distance
 * that occurs in the most documents. Returns candidates ordered best first.
 */
export function suggestCorrections(
  word: string,
  vocab: Iterable<VocabEntry>,
  userMax: 0 | 1 | 2 = 1,
  limit = 5,
  /** Set when the vocabulary holds stems: a stem within the allowed edits of a prefix of the word also counts. */
  stems = false,
): { term: string; docs: number; distance: number }[] {
  const max = typoMaxEdits(word, userMax);
  if (max === 0) return [];
  const w = word.toLowerCase();
  const out: { term: string; docs: number; distance: number }[] = [];
  for (const v of vocab) {
    if (v.term.length - w.length > max || (!stems && w.length - v.term.length > max)) continue;
    let d = damerauLevenshtein(w, v.term, max);
    if (stems && d > 1 && v.term.length >= TYPO_MIN_WORD_LENGTH && v.term.length < w.length) {
      d = Math.min(d, damerauLevenshtein(w.slice(0, v.term.length), v.term, max), damerauLevenshtein(w.slice(0, v.term.length + 1), v.term, max));
    }
    if (d >= 1 && d <= max) out.push({ term: v.term, docs: v.docs, distance: d });
  }
  out.sort((a, b) => b.docs - a.docs || a.distance - b.distance || (a.term < b.term ? -1 : 1));
  return out.slice(0, limit);
}

/** Estimated token count of a text, for the Context basket's size meter. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** The normalised mean of a set of vectors. */
export function meanVector(vectors: ArrayLike<number>[]): Float32Array | null {
  if (vectors.length === 0) return null;
  const dims = vectors[0]!.length;
  const out = new Float32Array(dims);
  for (const v of vectors) for (let i = 0; i < dims; i++) out[i]! += v[i]!;
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += out[i]! * out[i]!;
  norm = Math.sqrt(norm);
  if (norm === 0) return out;
  for (let i = 0; i < dims; i++) out[i]! /= norm;
  return out;
}

/** nDCG@k for graded relevance labels. */
export function ndcg(rankedIds: string[], relevant: Record<string, number>, k = 10): number {
  const dcg = rankedIds.slice(0, k).reduce((sum, id, i) => sum + (2 ** (relevant[id] ?? 0) - 1) / Math.log2(i + 2), 0);
  const ideal = Object.values(relevant)
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((sum, g, i) => sum + (2 ** g - 1) / Math.log2(i + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

export function recallAt(rankedIds: string[], relevant: Record<string, number>, k = 20): number {
  const ids = Object.keys(relevant).filter((id) => relevant[id]! > 0);
  if (ids.length === 0) return 0;
  const top = new Set(rankedIds.slice(0, k));
  return ids.filter((id) => top.has(id)).length / ids.length;
}
