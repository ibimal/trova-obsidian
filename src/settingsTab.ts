// The settings tab, grouped as Scope, Search, Connections, Ask, Context, Engine, Advanced. It uses
// Obsidian's declarative settings, so every setting shows up in Obsidian's settings search. Each
// setting takes effect without a restart.

import { PluginSettingTab, type App, type SettingDefinitionItem } from "obsidian";
import { t } from "./i18n/en.js";
import type TrovaPlugin from "./main.js";
import type { TrovaSettings } from "./settings.js";
import { clampSetting, settingRange } from "./state/sanitize.js";

/** The label counts and Deep time limits the settings offer. */
const GRAPH_LABEL_CHOICES = [0, 3, 5, 8, 10];
const DEEP_SECONDS_CHOICES = [5, 10, 15, 30, 60];

/** A change that reindexes or restarts something waits this long after the last edit. */
const APPLY_DELAY_MS = 600;

type Effect = "none" | "scope" | "engine" | "editor" | "http" | "debug" | "connections";

/** A control's key: a setting, or the folder context, which the plugin stores beside the settings. */
type Key = keyof TrovaSettings | "folderContext";

/** What each setting needs after it changes. A setting not listed needs nothing. */
const EFFECTS: Partial<Record<Key, Effect>> = {
  includeGlobs: "scope",
  excludeGlobs: "scope",
  outsideFolders: "engine",
  attachmentTypes: "engine",
  folderContext: "engine",
  showLoose: "connections",
  hideLinked: "connections",
  inlineBadges: "editor",
  footerPanel: "editor",
  engineMode: "engine",
  engineAddress: "engine",
  engineToken: "engine",
  engineBinaryPath: "engine",
  backgroundIndexing: "engine",
  pauseOnBattery: "engine",
  httpApi: "http",
  httpApiPort: "http",
  httpApiToken: "http",
  debugLog: "debug",
};

/** Settings kept as lists and edited as one entry per line. */
const LINE_LISTS = new Set<Key>([
  "includeGlobs",
  "excludeGlobs",
  "attachmentTypes",
  "careExcludedFolders",
]);

/** Settings stored as numbers but edited as text: dropdowns, and fields checked by inRange(). */
const NUMBER_DROPDOWNS = new Set<Key>(["typoTolerance", "graphLabels", "askDeepSeconds"]);
const NUMBER_FIELDS = new Set<Key>(["restoreQuerySeconds", "contextWarnTokens", "httpApiPort"]);

const lines = (text: string) =>
  text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

/** Parses "4, 3, 2, 1" into field weights, or returns null when it is not four numbers of 0 or more. */
export function parseFieldWeights(text: string): TrovaSettings["fieldWeights"] | null {
  const n = text.split(",").map((x) => Number(x.trim()));
  if (n.length !== 4 || !n.every((x) => Number.isFinite(x) && x >= 0)) return null;
  return { filename: n[0]!, aliases: n[1]!, headings: n[2]!, body: n[3]! };
}

/** Parses "Folder/Path: description" lines into folder context; lines without a description are skipped. */
export function parseFolderContext(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    if (at > 0 && line.slice(at + 1).trim())
      map[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return map;
}

/** Turns absolute folder paths, one per line, into outside folders with a collection name each. */
export function parseOutsideFolders(text: string): TrovaSettings["outsideFolders"] {
  return lines(text).map((path) => ({
    path,
    name: `folder-${
      (path.split(/[\\/]/).filter(Boolean).pop() ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "x"
    }`,
  }));
}

export class TrovaSettingTab extends PluginSettingTab {
  private pending = new Map<Effect, number>();

  constructor(
    app: App,
    private plugin: TrovaPlugin,
  ) {
    super(app, plugin);
  }

  override getControlValue(key: string): unknown {
    const k = key as Key;
    const s = this.plugin.settings;
    if (k === "folderContext")
      return Object.entries(this.plugin.store.data.folderContext)
        .map(([folder, text]) => `${folder}: ${text}`)
        .join("\n");
    if (k === "outsideFolders") return s.outsideFolders.map((f) => f.path).join("\n");
    if (k === "fieldWeights")
      return `${s.fieldWeights.filename}, ${s.fieldWeights.aliases}, ${s.fieldWeights.headings}, ${s.fieldWeights.body}`;
    if (LINE_LISTS.has(k)) return (s[k as keyof TrovaSettings] as string[]).join("\n");
    const value = s[k];
    return (NUMBER_DROPDOWNS.has(k) || NUMBER_FIELDS.has(k)) && typeof value === "number"
      ? String(value)
      : value;
  }

  override setControlValue(key: string, value: unknown): void {
    const k = key as Key;
    if (k === "folderContext") {
      this.plugin.store.data.folderContext = parseFolderContext(String(value));
      this.plugin.store.touch();
    } else {
      this.plugin.store.updateSettings({ [k]: this.toStored(k, value) });
    }
    this.apply(EFFECTS[k] ?? "none");
    // Other rows show or hide depending on these two.
    if (k === "engineMode" || k === "restoreQuery") this.refreshDomState();
  }

  /** Applies effects that are still waiting when the user leaves the tab. */
  override hide(): void {
    for (const [effect, timer] of this.pending) {
      window.clearTimeout(timer);
      this.plugin.applySettings(effect);
    }
    this.pending.clear();
    super.hide();
  }

  /** The stored form of a control's value. */
  private toStored(k: keyof TrovaSettings, value: unknown): unknown {
    if (LINE_LISTS.has(k)) return lines(String(value));
    if (k === "outsideFolders") return parseOutsideFolders(String(value));
    if (k === "fieldWeights")
      return parseFieldWeights(String(value)) ?? this.plugin.settings.fieldWeights;
    if (NUMBER_DROPDOWNS.has(k)) return Number(value);
    if (NUMBER_FIELDS.has(k)) return clampSetting(k, Number(value));
    if (typeof value === "number") return clampSetting(k, value);
    if (typeof value === "string") return value.trim();
    return value;
  }

  /** Runs an effect now, or, for one that reindexes or restarts something, once edits pause. */
  private apply(effect: Effect): void {
    if (
      effect === "none" ||
      effect === "editor" ||
      effect === "connections" ||
      effect === "debug"
    ) {
      this.plugin.applySettings(effect);
      return;
    }
    window.clearTimeout(this.pending.get(effect));
    this.pending.set(
      effect,
      window.setTimeout(() => {
        this.pending.delete(effect);
        this.plugin.applySettings(effect);
      }, APPLY_DELAY_MS),
    );
  }

  /**
   * Checks a typed number against its setting's limits and returns what is allowed when it is
   * outside them. Numbers use text controls: Obsidian's number control rejects an invalid value
   * without showing the message.
   */
  private inRange(key: keyof TrovaSettings): (text: string) => string | void {
    const range = settingRange(key);
    return (text) => {
      const value = text.trim() === "" ? NaN : Number(text);
      if (!range) return Number.isFinite(value) ? undefined : "Enter a number.";
      if (!Number.isFinite(value) || value < range.min || value > range.max)
        return `Enter a number from ${range.min} to ${range.max}.`;
      if (range.integer && !Number.isInteger(value)) return "Enter a whole number.";
    };
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const s = () => this.plugin.settings;
    const external = () => s().engineMode === "external";
    return [
      {
        type: "group",
        heading: t("secScope"),
        items: [
          {
            name: "Indexed folders",
            desc: "Include globs, one per line. Empty means the whole vault. Obsidian's excluded files are always honoured.",
            control: { type: "textarea", key: "includeGlobs", placeholder: "Projects/**" },
          },
          {
            name: "Excluded folders",
            desc: "Exclude globs, one per line. A note with `trova: false` in its frontmatter is excluded everywhere.",
            control: { type: "textarea", key: "excludeGlobs", placeholder: "Archive\nPrivate/**" },
          },
          {
            name: "Outside folders",
            desc: "Folders outside the vault to search in the same modal, one absolute path per line. Results open in the default app.",
            control: {
              type: "textarea",
              key: "outsideFolders",
              placeholder: "/Users/me/Documents/Papers",
            },
          },
          {
            name: "Attachment types",
            desc: "One per line: pdf, canvas, image (OCR from the Text Extractor plugin), office (docx, pptx, xlsx; off by default).",
            aliases: ["pdf", "ocr", "canvas"],
            control: {
              type: "textarea",
              key: "attachmentTypes",
              placeholder: "pdf\ncanvas\nimage",
            },
          },
          {
            name: "Per-folder context",
            desc: "One line per folder: `Folder/Path: description`. It improves results and labels them.",
            control: {
              type: "textarea",
              key: "folderContext",
              placeholder: "Projects/Trova: Design notes for the search engine",
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("secSearch"),
        items: [
          {
            name: "Typo tolerance",
            desc: "Corrects misspelt words when a query returns few hits. One edit applies to words of 5 or more letters.",
            aliases: ["fuzzy", "spelling"],
            control: {
              type: "dropdown",
              key: "typoTolerance",
              options: { "0": "Off", "1": "1 edit", "2": "Up to 2 edits" },
            },
          },
          {
            name: "Recency boost in Instant search",
            desc: "Recently opened notes rank slightly higher.",
            control: { type: "toggle", key: "recencyBoost" },
          },
          {
            name: "Semantic rows in Instant search",
            desc: "Adds a 'Related by meaning' section for queries of three or more words. Needs the engine.",
            control: { type: "toggle", key: "semanticRows" },
          },
          {
            name: "Vim keys in the modal",
            desc: "Ctrl+J and Ctrl+K move the selection.",
            control: { type: "toggle", key: "vimKeys" },
          },
          {
            name: "Restore the last query on reopen",
            desc: "Reopening the modal soon after closing it restores the query and the selection.",
            control: { type: "toggle", key: "restoreQuery" },
          },
          {
            name: "Restore window (seconds)",
            visible: () => s().restoreQuery,
            control: {
              type: "text",
              key: "restoreQuerySeconds",
              validate: this.inRange("restoreQuerySeconds"),
            },
          },
          {
            name: "Field weights",
            desc: "Filename, aliases, headings, body. The engine ranks on path, title and body only; aliases and headings are matched by the worker.",
            control: {
              type: "text",
              key: "fieldWeights",
              validate: (v: string) =>
                parseFieldWeights(v)
                  ? undefined
                  : "Enter four numbers of 0 or more, separated by commas.",
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("secConnections"),
        items: [
          {
            name: "Connections refresh",
            control: {
              type: "dropdown",
              key: "connectionsRefresh",
              options: { switch: "On note switch", idle: "On idle", manual: "Manual" },
            },
          },
          {
            name: "Show loose matches in Connections",
            desc: "Also shows results with a similarity of 0.30 to 0.45.",
            control: { type: "toggle", key: "showLoose" },
          },
          {
            name: "Hide already-linked notes in Connections",
            control: { type: "toggle", key: "hideLinked" },
          },
          {
            name: "Inline badges",
            desc: "A small count beside each heading shows how many strong matches that section has.",
            control: { type: "toggle", key: "inlineBadges" },
          },
          {
            name: "Footer panel",
            desc: "A strip under the editor with the top five connections for the section being edited.",
            control: { type: "toggle", key: "footerPanel" },
          },
          {
            name: "Rediscover",
            desc: "A daily list in Vault care of notes closely related to what you opened recently, which you have not opened in a long time.",
            control: { type: "toggle", key: "rediscover" },
          },
          {
            name: "Graph labels in the Connections pane",
            desc: "How many of the most similar notes the graph names without a hover. The note you point at, and its neighbours, are always named.",
            control: {
              type: "dropdown",
              key: "graphLabels",
              options: Object.fromEntries(
                GRAPH_LABEL_CHOICES.map((n) => [String(n), n === 0 ? "None" : String(n)]),
              ),
            },
          },
          {
            name: "Excluded from orphans and Rediscover",
            desc: "Folders, one per line. The daily notes folder and the templates folder are always excluded.",
            control: { type: "textarea", key: "careExcludedFolders", placeholder: "Inbox" },
          },
        ],
      },
      {
        type: "group",
        heading: t("secAsk"),
        items: [
          {
            name: "Ask mode",
            desc: "Auto picks Fast or Deep from the query's shape. Deep adds query expansion and rerank, and needs a 1.7 GB model download.",
            control: {
              type: "dropdown",
              key: "askMode",
              options: { auto: t("modeAuto"), fast: t("modeFast"), deep: t("modeDeep") },
            },
          },
          {
            name: "Deep mode time limit",
            desc: "Deep mode expands the question and reranks the top results. Past this limit, Ask keeps the results from before reranking. The results appear first either way, so a longer limit only delays the reordering.",
            control: {
              type: "dropdown",
              key: "askDeepSeconds",
              options: Object.fromEntries(
                DEEP_SECONDS_CHOICES.map((n) => [String(n), `${n} seconds`]),
              ),
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("secContext"),
        items: [
          {
            name: "Context size warning (tokens)",
            desc: "The basket warns above this estimated token count.",
            control: {
              type: "text",
              key: "contextWarnTokens",
              validate: this.inRange("contextWarnTokens"),
            },
          },
          {
            name: "Folder for saved baskets",
            desc: "Where 'Save as note' puts the note. Empty uses the default folder for new notes.",
            control: { type: "folder", key: "contextNoteFolder", placeholder: "Research" },
          },
        ],
      },
      {
        type: "group",
        heading: t("secEngine"),
        items: [
          {
            name: "Engine",
            desc: "Managed: the plugin starts the daemon. External: connect to an address you run yourself.",
            control: {
              type: "dropdown",
              key: "engineMode",
              options: { managed: "Managed", external: "External address" },
            },
          },
          {
            name: "Engine address",
            visible: external,
            control: { type: "text", key: "engineAddress", placeholder: "http://127.0.0.1:8765" },
          },
          {
            name: "Engine token",
            desc: "The bearer token of the external engine.",
            visible: external,
            control: { type: "text", key: "engineToken" },
          },
          {
            name: "Engine binary path",
            desc: "Empty auto-detects `trova` on PATH and in the usual install folders.",
            visible: () => !external(),
            control: {
              type: "text",
              key: "engineBinaryPath",
              placeholder: "/opt/homebrew/bin/trova",
            },
          },
          {
            name: "Embedding model",
            desc: "Empty uses the engine default. A change applies when the daemon next starts and re-embeds in the background; old results serve until it is done.",
            control: {
              type: "text",
              key: "embeddingModel",
              placeholder: "hf:…/model.gguf or a local file path",
            },
          },
          {
            name: "GPU",
            desc: "Applies when the daemon next starts.",
            control: {
              type: "dropdown",
              key: "gpu",
              options: { auto: "Auto", metal: "Metal", cpu: "CPU only" },
            },
          },
          {
            name: "Background indexing",
            desc: "Indexing always pauses while you type.",
            control: { type: "toggle", key: "backgroundIndexing" },
          },
          { name: "Pause indexing on battery", control: { type: "toggle", key: "pauseOnBattery" } },
          {
            name: t("cmdWelcome"),
            desc: "Shows the first-run screen again: the engine check, the scope and Start.",
            action: () => this.plugin.showWelcome(),
          },
        ],
      },
      {
        type: "group",
        heading: t("secAdvanced"),
        items: [
          {
            name: "Local HTTP API for other apps",
            desc: "Read-only /search, /ask and /related on 127.0.0.1, for browser extensions and launchers.",
            control: { type: "toggle", key: "httpApi" },
          },
          {
            name: "HTTP API port",
            control: { type: "text", key: "httpApiPort", validate: this.inRange("httpApiPort") },
          },
          {
            name: "HTTP API token",
            desc: "Send it as `Authorization: Bearer <token>`.",
            render: (setting) => {
              let field: { setValue(v: string): unknown } | null = null;
              setting
                .addText((c) => {
                  c.setValue(s().httpApiToken);
                  c.inputEl.readOnly = true;
                  field = c;
                })
                .addButton((b) =>
                  b.setButtonText("New token").onClick(() => {
                    this.setControlValue("httpApiToken", this.plugin.newToken());
                    field?.setValue(s().httpApiToken);
                  }),
                );
            },
          },
          {
            name: "Debug log",
            desc: "Writes requests and queries to ~/.cache/trova/logs/. Off: prompts, queries and results are never logged.",
            control: { type: "toggle", key: "debugLog" },
          },
        ],
      },
    ];
  }
}
