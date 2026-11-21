// Types for the /v1 engine contract. The plugin, the engine and the CLI all import these,
// so the two sides of the API cannot drift.

export const API_VERSION = "1.0";
export const API_MAJOR = 1;

// ---------- Query ----------

export type TermKind = "word" | "exact" | "phrase";
export interface Term {
  kind: TermKind;
  text: string;
  field?: "title" | "heading";
}

export type FilterOp = "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "contains" | "in";
export interface Filter {
  /** "path", "ext", "tag", "modified", "created", "is", "links", or "fm.<key>" */
  field: string;
  op: FilterOp;
  value: string | number | string[];
  negate?: boolean;
}

export type Lane = "lex" | "vec" | "hyde";
export interface ParsedQuery {
  mode: "instant" | "ask";
  lane?: Lane;
  /** AND of OR-groups */
  must: Term[][];
  mustNot: Term[];
  filters: Filter[];
  raw: string;
}

/** A problem the query bar underlines. The rest of the query still runs. */
export interface QueryDiagnostic {
  start: number;
  end: number;
  code: "unknown_operator" | "bad_value";
  message: string;
}

// ---------- Results ----------

export type Stage = "lex" | "vec" | "fused" | "rerank";
export type MatchedBy = "lex" | "fuzzy" | "vec" | "rerank";
export type Label = "strong" | "related" | "loose";

export interface BlockRef {
  id: string;
  headings: string[];
  start: number;
  end: number;
}

export interface Scores {
  lex?: number;
  vec?: number;
  fused?: number;
  rerank?: number;
  /** Rank in the fused list, starting at 1. Shown by the Explain panel. */
  fusedRank?: number;
}

export interface Result {
  /** Stable id of source + block. Clients merge streamed batches on it. */
  id: string;
  source: string;
  path: string;
  title: string;
  collection?: string;
  block?: BlockRef;
  snippet: string;
  highlights: [number, number][];
  scores: Scores;
  matchedBy: MatchedBy[];
  label: Label;
  /** Best blocks of a source. Only set by `related`. */
  blocks?: Result[];
  /** Attachment type badge, such as "pdf" or "image". */
  type?: string;
  /** Path context: the one-line description of the folder the source is in. */
  context?: string;
  /** Why-related data. Only set by `related`. */
  why?: { keywords: string[]; links: string[]; tags: string[] };
}

export interface Correction {
  from: string;
  to: string;
}

export interface ResultBatch {
  stage: Stage;
  results: Result[];
  final: boolean;
  correction?: Correction;
  /** Deep mode: the generated sub-queries, on the first batch. */
  expansions?: { type: Lane; query: string }[];
  /** The mode that Auto picked, or the mode the engine fell back to. */
  mode?: "fast" | "deep";
  /** "rerank_skipped" when Deep passed its deadline, "model_missing" when it fell back to Fast. */
  note?: "rerank_skipped" | "model_missing";
  error?: ErrorBody["error"];
}

// ---------- Requests ----------

export interface SearchRequest {
  query: ParsedQuery;
  lanes: ("lex" | "vec" | "hybrid")[];
  collections?: string[];
  limit?: number;
  fuzzy?: boolean;
  deadlineMs?: number;
}

export interface AskRequest {
  query: ParsedQuery;
  mode: "auto" | "fast" | "deep";
  collections?: string[];
  limit?: number;
  fuzzy?: boolean;
  deadlineMs?: number;
  /** Set after the user confirms the 1.7 GB download of the Deep models. */
  allowModelDownload?: boolean;
}

/** Exactly one of `source`, `block` or `text` is set. */
export interface EngineAnchor {
  source?: string | null;
  block?: string | null;
  text?: string | null;
}

export interface RelatedRequest {
  anchor: EngineAnchor;
  granularity?: "source" | "block" | "both";
  limit?: number;
  blocksPerSource?: number;
  exclude?: { sources?: string[]; linkedFromAnchor?: boolean };
  filters?: Filter[];
  collections?: string[];
  /** Include Loose results (cosine 0.30 to 0.45). */
  loose?: boolean;
}
export interface RelatedResponse {
  anchorIndexed: boolean;
  results: Result[];
}

export interface VocabSuggestRequest {
  terms: string[];
}
export interface VocabSuggestion {
  term: string;
  docs: number;
  distance: number;
}
export interface VocabSuggestResponse {
  suggestions: Record<string, VocabSuggestion[]>;
}

export interface ScoreRequest {
  pairs: [EngineAnchor, EngineAnchor][];
}
export interface ScoreResponse {
  scores: (number | null)[];
}

export interface GetRequest {
  /** A source id, a block id, or a path relative to a collection. */
  id: string;
  collection?: string;
  /** For a block: also return this many neighbouring blocks on each side. */
  neighbours?: number;
}
export interface DocumentBody {
  id: string;
  source: string;
  path: string;
  title: string;
  block?: BlockRef;
  content: string;
  neighbours?: { before: DocumentBody[]; after: DocumentBody[] };
}
export interface MultiGetRequest {
  ids?: string[];
  glob?: string;
  collection?: string;
  maxBytes?: number;
}
export interface MultiGetResponse {
  documents: DocumentBody[];
  errors: { id: string; code: ErrorCode }[];
}

export interface SyncRequest {
  collection: string;
  changed?: string[];
  deleted?: string[];
  renamed?: { from: string; to: string }[];
  full?: boolean;
}
export interface SyncResponse {
  jobId: string;
}

export type ModelState = "ready" | "loading" | "downloading" | "missing";
export type Capability =
  | "lex"
  | "vec"
  | "fuzzy"
  | "relatedByVector"
  | "blocks"
  | "rerank"
  | "expansion"
  | "attachments"
  | "duplicates"
  | "topics"
  | "graph";

export type JobKind = "sync" | "embed" | "duplicates" | "topics" | "models";
export type JobState = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";
export interface JobInfo {
  jobId: string;
  kind: JobKind;
  state: JobState;
  done: number;
  total: number;
  error?: string;
  started?: number;
  finished?: number;
}

export interface CollectionStatus {
  name: string;
  path: string;
  sources: number;
  embedded: number;
  pending: number;
  /** Markdown notes with more than 2 MB of text. qmd indexes them whole; only attachment text is cut at 2 MB. */
  oversized?: string[];
  lastIndexed?: number;
}

export interface IndexStatus {
  api: string;
  engine: { name: string; version: string; backend: string };
  capabilities: Capability[];
  models: {
    embed: { id?: string; dims?: number; state: ModelState; progress?: number };
    rerank: { id?: string; state: ModelState; progress?: number };
    expand: { id?: string; state: ModelState; progress?: number };
  };
  collections: CollectionStatus[];
  jobs: JobInfo[];
  paused?: boolean;
  /** Set while vectors made by an older embedding model are being replaced. */
  reembedding?: { done: number; total: number };
}

export interface CollectionOptions {
  /** Include globs, relative to the collection root. Empty means everything. */
  include?: string[];
  exclude?: string[];
  /** Attachment types to extract: "pdf", "canvas", "office", "image". */
  attachments?: string[];
  /** "vault" collections get OCR text pushed by the plugin; "folder" ones are outside folders. */
  kind?: "vault" | "folder";
}
export interface CollectionAddRequest {
  name: string;
  path: string;
  options?: CollectionOptions;
  /** Path context: folder path -> one-line description. Replaces the stored map when set. */
  context?: Record<string, string>;
}
export interface CollectionInfo {
  name: string;
  path: string;
  options: CollectionOptions;
  context: Record<string, string>;
}

export interface MetadataKeysResponse {
  keys: Record<string, string[]>;
}

/** Extension to the contract: the plugin pushes OCR text from the Text Extractor plugin. */
export interface AttachmentTextRequest {
  collection: string;
  path: string;
  text: string;
}

/** Extension: background near-duplicate scan. */
export interface DuplicatePair {
  a: string;
  b: string;
  aTitle: string;
  bTitle: string;
  aPath: string;
  bPath: string;
  kind: "block" | "source";
  similarity: number;
}
export interface DuplicatesResponse {
  state: "none" | "running" | "done";
  jobId?: string;
  pairs: DuplicatePair[];
  computedAt?: number;
}

/** Extension: topic map clusters. */
export interface TopicCluster {
  id: number;
  label: string[];
  x: number;
  y: number;
  sources: { id: string; path: string; title: string; x: number; y: number }[];
}
export interface TopicsResponse {
  state: "none" | "running" | "done";
  jobId?: string;
  clusters: TopicCluster[];
  computedAt?: number;
}

/** Extension: the similarity graph around one anchor, for the graph view. */
export interface GraphRequest {
  anchor: EngineAnchor;
  /** How many related sources to return around the anchor. Default 24, at most 60. */
  limit?: number;
  collections?: string[];
  filters?: Filter[];
  loose?: boolean;
}
export interface GraphNode {
  /** The source id. */
  id: string;
  path: string;
  title: string;
  collection: string;
  /** Cosine similarity to the anchor; 1 for the anchor itself. */
  score: number;
  label: Label;
  snippet: string;
  tags: string[];
}
export interface GraphEdge {
  a: string;
  b: string;
  similarity: number;
  /** True when one of the two notes already links to the other. */
  linked: boolean;
}
export interface GraphResponse {
  anchorIndexed: boolean;
  /** Null for a text anchor. */
  anchor: GraphNode | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------- Errors ----------

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "unsupported"
  | "cancelled"
  | "model_missing"
  | "model_loading"
  | "busy"
  | "internal";

export interface ErrorBody {
  error: { code: ErrorCode; message: string; retryable: boolean };
}

export const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  unsupported: 422,
  cancelled: 499,
  model_missing: 503,
  model_loading: 503,
  busy: 503,
  internal: 500,
};

export class EngineError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public retryable = false,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EngineError";
  }
  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, retryable: this.retryable } };
  }
}

// ---------- Events ----------

export type EngineEventName =
  | "index.progress"
  | "index.ready"
  | "results.stale"
  | "engine.state"
  | "model.changed";

export interface EngineEvent {
  event: EngineEventName;
  data: Record<string, unknown>;
}

export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  version: string;
  api: string;
}

// ---------- Source metadata, shared by the engine's sidecar table and the worker ----------

export interface SourceMeta {
  /** Path relative to the collection root. */
  path: string;
  title: string;
  aliases: string[];
  /** Tags without the leading "#", lower-cased. */
  tags: string[];
  /** Resolved outgoing link targets, as paths relative to the collection root. */
  links: string[];
  frontmatter: Record<string, unknown>;
  created: number;
  modified: number;
  wordCount: number;
  excluded: boolean;
  /** True when no source links here and this source links nowhere. */
  orphan?: boolean;
}
