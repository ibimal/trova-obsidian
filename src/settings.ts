import type { Filter } from "@trova/contract";

export interface TrovaSettings {
  // Scope
  includeGlobs: string[];
  excludeGlobs: string[];
  outsideFolders: { name: string; path: string }[];
  attachmentTypes: string[];
  // Search
  fieldWeights: { filename: number; aliases: number; headings: number; body: number };
  typoTolerance: 0 | 1 | 2;
  recencyBoost: boolean;
  semanticRows: boolean;
  vimKeys: boolean;
  restoreQuery: boolean;
  restoreQuerySeconds: number;
  // Connections
  connectionsRefresh: "switch" | "idle" | "manual";
  showLoose: boolean;
  hideLinked: boolean;
  inlineBadges: boolean;
  footerPanel: boolean;
  rediscover: boolean;
  careExcludedFolders: string[];
  /** How many of the most similar notes the Connections pane's graph labels without a hover. */
  graphLabels: number;
  // Ask
  askMode: "auto" | "fast" | "deep";
  /** Deep mode's time limit in seconds; past it, Ask shows the results before reranking. */
  askDeepSeconds: number;
  // Context
  contextWarnTokens: number;
  contextNoteFolder: string;
  // Engine
  engineMode: "managed" | "external";
  engineAddress: string;
  engineToken: string;
  engineBinaryPath: string;
  embeddingModel: string;
  gpu: "auto" | "metal" | "cpu";
  backgroundIndexing: boolean;
  pauseOnBattery: boolean;
  // Advanced
  httpApi: boolean;
  httpApiPort: number;
  httpApiToken: string;
  debugLog: boolean;
  onboarded: boolean;
}

export const DEFAULT_SETTINGS: TrovaSettings = {
  includeGlobs: [],
  excludeGlobs: [],
  outsideFolders: [],
  attachmentTypes: ["pdf", "canvas", "image"],
  fieldWeights: { filename: 4, aliases: 3, headings: 2, body: 1 },
  typoTolerance: 1,
  recencyBoost: true,
  semanticRows: true,
  vimKeys: false,
  restoreQuery: true,
  restoreQuerySeconds: 30,
  connectionsRefresh: "switch",
  showLoose: false,
  hideLinked: false,
  inlineBadges: false,
  footerPanel: false,
  rediscover: false,
  careExcludedFolders: [],
  graphLabels: 10,
  askMode: "auto",
  askDeepSeconds: 15,
  contextWarnTokens: 32000,
  contextNoteFolder: "",
  engineMode: "managed",
  engineAddress: "http://127.0.0.1:8765",
  engineToken: "",
  engineBinaryPath: "",
  embeddingModel: "",
  gpu: "auto",
  backgroundIndexing: true,
  pauseOnBattery: false,
  httpApi: false,
  httpApiPort: 51361,
  httpApiToken: "",
  debugLog: false,
  onboarded: false,
};

/** Synced plugin state, stored in data.json. */
export interface TrovaData {
  schema: 1;
  settings: TrovaSettings;
  /** anchor source id -> pinned result ids */
  pins: Record<string, string[]>;
  /** anchor source id -> hidden result ids */
  hides: Record<string, string[]>;
  filters: { connections: Filter[] };
  /** folder path -> one-line description */
  folderContext: Record<string, string>;
  /** Vault care choices the user made, kept across scans and restarts. */
  care: CareData;
}

export interface CareData {
  /** Near-duplicate pairs marked "Not a duplicate", as `pairKey` strings. */
  notDuplicates: string[];
  /** Source ids of notes marked "Keep unlinked", which the orphan list leaves out. */
  keepUnlinked: string[];
}

/** One key for a pair of ids, whichever order the scan gives them in. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\n${b}` : `${b}\n${a}`;
}

export function defaultData(): TrovaData {
  return { schema: 1, settings: { ...DEFAULT_SETTINGS }, pins: {}, hides: {}, filters: { connections: [] }, folderContext: {}, care: { notDuplicates: [], keepUnlinked: [] } };
}
