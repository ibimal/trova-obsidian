// The settings tab, grouped as Scope, Search, Connections, Ask, Context, Engine, Advanced. Each
// setting takes effect without a restart.

import { PluginSettingTab, Setting, type App } from "obsidian";
import { t } from "./i18n/en.js";
import type TrovaPlugin from "./main.js";
import type { TrovaSettings } from "./settings.js";
import { clampSetting } from "./state/sanitize.js";

/** The label counts and Deep time limits the settings offer. */
const GRAPH_LABEL_CHOICES = [0, 3, 5, 8, 10];
const DEEP_SECONDS_CHOICES = [5, 10, 15, 30, 60];

type Effect = "none" | "scope" | "engine" | "editor" | "http" | "debug" | "connections";

export class TrovaSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: TrovaPlugin,
  ) {
    super(app, plugin);
  }

  private set<K extends keyof TrovaSettings>(key: K, value: TrovaSettings[K], effect: Effect = "none"): void {
    this.plugin.store.updateSettings({ [key]: value } as Partial<TrovaSettings>);
    this.plugin.applySettings(effect);
  }

  private toggle(el: HTMLElement, name: string, desc: string, key: keyof TrovaSettings, effect: Effect = "none"): void {
    new Setting(el).setName(name).setDesc(desc).addToggle((c) => c.setValue(this.plugin.settings[key] as boolean).onChange((v) => this.set(key, v as never, effect)));
  }

  private lines(el: HTMLElement, name: string, desc: string, key: "includeGlobs" | "excludeGlobs" | "attachmentTypes" | "careExcludedFolders", effect: Effect, placeholder: string): void {
    new Setting(el).setName(name).setDesc(desc).addTextArea((c) => {
      c.setPlaceholder(placeholder).setValue(this.plugin.settings[key].join("\n"));
      // The value is applied when the field loses focus, never on a keystroke.
      c.inputEl.addEventListener("blur", () => this.set(key, c.getValue().split("\n").map((s) => s.trim()).filter(Boolean), effect));
    });
  }

  private text(el: HTMLElement, name: string, desc: string, key: keyof TrovaSettings, effect: Effect = "none", placeholder = ""): void {
    new Setting(el).setName(name).setDesc(desc).addText((c) => {
      c.setPlaceholder(placeholder).setValue(String(this.plugin.settings[key] ?? ""));
      c.inputEl.addEventListener("blur", () => {
        const current = this.plugin.settings[key];
        if (typeof current !== "number") return this.set(key, c.getValue().trim() as never, effect);
        // A number outside its range is brought into it, and the field shows the value kept.
        const typed = Number(c.getValue().trim());
        const value = c.getValue().trim() !== "" && Number.isFinite(typed) ? clampSetting(key, typed) : current;
        c.setValue(String(value));
        this.set(key, value as never, effect);
      });
    });
  }

  override display(): void {
    const el = this.containerEl;
    el.empty();
    const s = this.plugin.settings;
    const desktop = this.plugin.isDesktop;

    new Setting(el).setName(t("secScope")).setHeading();
    this.lines(el, "Indexed folders", "Include globs, one per line. Empty means the whole vault. Obsidian's excluded files are always honoured.", "includeGlobs", "scope", "Projects/**");
    this.lines(el, "Excluded folders", "Exclude globs, one per line. A note with `trova: false` in its frontmatter is excluded everywhere.", "excludeGlobs", "scope", "Archive\nPrivate/**");
    if (desktop) {
      new Setting(el).setName("Outside folders").setDesc("Folders outside the vault to search in the same modal, one absolute path per line. Results open in the default app.").addTextArea((c) => {
        c.setPlaceholder("/Users/me/Documents/Papers").setValue(s.outsideFolders.map((f) => f.path).join("\n"));
        c.inputEl.addEventListener("blur", () => {
          const folders = c.getValue().split("\n").map((p) => p.trim()).filter(Boolean).map((path) => ({
            path,
            name: `folder-${path.split(/[\\/]/).filter(Boolean).pop()!.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x"}`,
          }));
          this.set("outsideFolders", folders, "engine");
        });
      });
      this.lines(el, "Attachment types", "One per line: pdf, canvas, image (OCR from the Text Extractor plugin), office (docx, pptx, xlsx; off by default).", "attachmentTypes", "engine", "pdf\ncanvas\nimage");
      new Setting(el).setName("Per-folder context").setDesc("One line per folder: `Folder/Path: description`. It improves results and labels them.").addTextArea((c) => {
        c.setPlaceholder("Projects/Trova: Design notes for the search engine").setValue(Object.entries(this.plugin.store.data.folderContext).map(([k, v]) => `${k}: ${v}`).join("\n"));
        c.inputEl.addEventListener("blur", () => {
          const map: Record<string, string> = {};
          for (const line of c.getValue().split("\n")) {
            const at = line.indexOf(":");
            if (at > 0 && line.slice(at + 1).trim()) map[line.slice(0, at).trim()] = line.slice(at + 1).trim();
          }
          this.plugin.store.data.folderContext = map;
          this.plugin.store.touch();
          this.plugin.applySettings("engine");
        });
      });
    }

    new Setting(el).setName(t("secSearch")).setHeading();
    new Setting(el).setName("Typo tolerance").setDesc("Corrects misspelt words when a query returns few hits. One edit applies to words of 5 or more letters.").addDropdown((c) =>
      c.addOptions({ "0": "Off", "1": "1 edit", "2": "Up to 2 edits" }).setValue(String(s.typoTolerance)).onChange((v) => this.set("typoTolerance", Number(v) as 0 | 1 | 2)),
    );
    this.toggle(el, "Recency boost in Instant search", "Recently opened notes rank slightly higher.", "recencyBoost");
    this.toggle(el, "Semantic rows in Instant search", "Adds a 'Related by meaning' section for queries of three or more words. Needs the engine.", "semanticRows");
    this.toggle(el, "Vim keys in the modal", "Ctrl+J and Ctrl+K move the selection.", "vimKeys");
    this.toggle(el, "Restore the last query on reopen", "Reopening the modal soon after closing it restores the query and the selection.", "restoreQuery");
    this.text(el, "Restore window (seconds)", "", "restoreQuerySeconds");
    new Setting(el).setName("Field weights").setDesc("Filename, aliases, headings, body. The engine ranks on path, title and body only; aliases and headings are matched by the worker.").addText((c) => {
      const w = s.fieldWeights;
      c.setValue(`${w.filename}, ${w.aliases}, ${w.headings}, ${w.body}`);
      c.inputEl.addEventListener("blur", () => {
        const n = c.getValue().split(",").map((x) => Number(x.trim()));
        if (n.length === 4 && n.every((x) => Number.isFinite(x) && x >= 0)) this.set("fieldWeights", { filename: n[0]!, aliases: n[1]!, headings: n[2]!, body: n[3]! });
      });
    });

    new Setting(el).setName(t("secConnections")).setHeading();
    new Setting(el).setName("Connections refresh").addDropdown((c) =>
      c.addOptions({ switch: "On note switch", idle: "On idle", manual: "Manual" }).setValue(s.connectionsRefresh).onChange((v) => this.set("connectionsRefresh", v as TrovaSettings["connectionsRefresh"])),
    );
    this.toggle(el, "Show loose matches in Connections", "Also shows results with a similarity of 0.30 to 0.45.", "showLoose", "connections");
    this.toggle(el, "Hide already-linked notes in Connections", "", "hideLinked", "connections");
    this.toggle(el, "Inline badges", "A small count beside each heading shows how many strong matches that section has.", "inlineBadges", "editor");
    this.toggle(el, "Footer panel", "A strip under the editor with the top five connections for the section being edited.", "footerPanel", "editor");
    this.toggle(el, "Rediscover", "A daily list in Vault care of notes closely related to what you opened recently, which you have not opened in a long time.", "rediscover");
    new Setting(el).setName("Graph labels in the Connections pane").setDesc("How many of the most similar notes the graph names without a hover. The note you point at, and its neighbours, are always named.").addDropdown((c) =>
      c.addOptions(Object.fromEntries(GRAPH_LABEL_CHOICES.map((n) => [String(n), n === 0 ? "None" : String(n)]))).setValue(String(s.graphLabels)).onChange((v) => this.set("graphLabels", Number(v))),
    );
    this.lines(el, "Excluded from orphans and Rediscover", "Folders, one per line. The daily notes folder and the templates folder are always excluded.", "careExcludedFolders", "none", "Inbox");

    new Setting(el).setName(t("secAsk")).setHeading();
    new Setting(el).setName("Ask mode").setDesc("Auto picks Fast or Deep from the query's shape. Deep adds query expansion and rerank, and needs a 1.7 GB model download.").addDropdown((c) =>
      c.addOptions({ auto: t("modeAuto"), fast: t("modeFast"), deep: t("modeDeep") }).setValue(s.askMode).onChange((v) => this.set("askMode", v as TrovaSettings["askMode"])),
    );
    new Setting(el).setName("Deep mode time limit").setDesc("Deep mode expands the question and reranks the top results. Past this limit, Ask keeps the results from before reranking. The results appear first either way, so a longer limit only delays the reordering.").addDropdown((c) =>
      c.addOptions(Object.fromEntries(DEEP_SECONDS_CHOICES.map((n) => [String(n), `${n} seconds`]))).setValue(String(s.askDeepSeconds)).onChange((v) => this.set("askDeepSeconds", Number(v))),
    );

    new Setting(el).setName(t("secContext")).setHeading();
    this.text(el, "Context size warning (tokens)", "The basket warns above this estimated token count.", "contextWarnTokens");
    this.text(el, "Folder for saved baskets", "Where 'Save as note' puts the note. Empty uses the default folder for new notes.", "contextNoteFolder", "none", "Research");

    if (desktop) {
      new Setting(el).setName(t("secEngine")).setHeading();
      new Setting(el).setName("Engine").setDesc("Managed: the plugin starts the daemon. External: connect to an address you run yourself.").addDropdown((c) =>
        c.addOptions({ managed: "Managed", external: "External address" }).setValue(s.engineMode).onChange((v) => {
          this.set("engineMode", v as TrovaSettings["engineMode"], "engine");
          this.display();
        }),
      );
      if (s.engineMode === "external") {
        this.text(el, "Engine address", "", "engineAddress", "engine", "http://127.0.0.1:8765");
        this.text(el, "Engine token", "The bearer token of the external engine.", "engineToken", "engine");
      } else {
        this.text(el, "Engine binary path", "Empty auto-detects `trova` on PATH and in the usual install folders.", "engineBinaryPath", "engine", "/opt/homebrew/bin/trova");
      }
      this.text(el, "Embedding model", "Empty uses the engine default. A change applies when the daemon next starts and re-embeds in the background; old results serve until it is done.", "embeddingModel", "none", "hf:…/model.gguf or a local file path");
      new Setting(el).setName("GPU").setDesc("Applies when the daemon next starts.").addDropdown((c) =>
        c.addOptions({ auto: "Auto", metal: "Metal", cpu: "CPU only" }).setValue(s.gpu).onChange((v) => this.set("gpu", v as TrovaSettings["gpu"])),
      );
      this.toggle(el, "Background indexing", "Indexing always pauses while you type.", "backgroundIndexing", "engine");
      this.toggle(el, "Pause indexing on battery", "", "pauseOnBattery", "engine");
      new Setting(el).setName(t("cmdWelcome")).addButton((b) => b.setButtonText(t("cmdWelcome")).onClick(() => this.plugin.showWelcome()));
    }

    new Setting(el).setName(t("secAdvanced")).setHeading();
    if (desktop) {
      this.toggle(el, "Local HTTP API for other apps", "Read-only /search, /ask and /related on 127.0.0.1, for browser extensions and launchers.", "httpApi", "http");
      this.text(el, "HTTP API port", "", "httpApiPort", "http");
      new Setting(el).setName("HTTP API token").setDesc("Send it as `Authorization: Bearer <token>`.").addText((c) => {
        c.setValue(s.httpApiToken);
        c.inputEl.readOnly = true;
      }).addButton((b) => b.setButtonText("New token").onClick(() => {
        this.set("httpApiToken", this.plugin.newToken(), "http");
        this.display();
      }));
      this.toggle(el, "Debug log", "Writes requests and queries to ~/.cache/trova/logs/. Off: prompts, queries and results are never logged.", "debugLog", "debug");
    }
  }
}
