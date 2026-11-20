// The welcome screen. It checks for the engine, confirms the scope, and starts nothing before the
// user clicks Start. The plugin never installs executables; it shows the command.

import { Modal, Notice } from "obsidian";
import { API_VERSION } from "@trova/contract";
import { t } from "../i18n/en.js";
import type TrovaPlugin from "../main.js";

export class OnboardingModal extends Modal {
  private off: (() => void) | null = null;

  constructor(private plugin: TrovaPlugin) {
    super(plugin.app);
  }

  override onOpen(): void {
    this.modalEl.addClass("trova-welcome");
    this.titleEl.setText(t("welcomeTitle"));
    this.off = this.plugin.engine.onChange(() => this.render());
    this.render();
  }

  override onClose(): void {
    this.off?.();
    this.contentEl.empty();
  }

  private command(el: HTMLElement, command: string): void {
    const box = el.createDiv({ cls: "trova-command" });
    box.createEl("code", { text: command });
    box.createEl("button", { text: t("copyCommand") }).addEventListener("click", () => {
      void navigator.clipboard.writeText(command);
      new Notice(t("copied"));
    });
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    const { engine } = this.plugin;
    const s = engine.snapshot;
    el.createEl("p", { text: t("welcomeIntro") });

    const box = el.createDiv({ cls: "trova-welcome-engine" });
    const buttons = el.createDiv({ cls: "modal-button-container" });
    const withoutEngine = () => {
      this.plugin.local.onboarded = true;
      this.plugin.local.set("no-engine", true);
      engine.disable();
      this.close();
    };
    if (s.state === "ready") {
      box.createEl("p", { text: t("engineFound", { name: s.status?.engine.name ?? "trova", version: s.status?.engine.version ?? "" }) });
      // Confirm scope: what will be indexed, what is excluded, and the one download.
      const files = this.app.vault.getMarkdownFiles();
      const included = files.filter((f) => !this.plugin.indexer.isExcluded(f.path)).length;
      const scope = el.createDiv({ cls: "trova-welcome-scope" });
      scope.createEl("h4", { text: t("scopeTitle") });
      const list = scope.createEl("ul");
      list.createEl("li", { text: t("scopeNotes", { n: included.toLocaleString() }) });
      const excluded = this.plugin.indexer.excludeGlobs();
      list.createEl("li", { text: excluded.length ? t("scopeExcluded", { folders: excluded.join(", ") }) : t("scopeNoneExcluded") });
      if (s.status?.models.embed.state !== "ready") list.createEl("li", { text: t("scopeDownload") });
      el.appendChild(buttons);
      const start = buttons.createEl("button", { text: t("start"), cls: "mod-cta" });
      start.addEventListener("click", () => {
        this.plugin.local.onboarded = true;
        this.plugin.local.set("no-engine", false);
        this.plugin.announceFinish = true;
        void engine.startIndexing();
        this.close();
      });
      buttons.createEl("button", { text: t("continueWithout") }).addEventListener("click", withoutEngine);
      start.focus();
      return;
    }
    if (s.state === "connecting" || s.state === "idle") {
      box.createEl("p", { text: t("engineChecking") });
    } else if (s.state === "wrong-version") {
      box.createEl("p", { text: t("engineWrongVersion", { got: s.gotApi ?? "?", want: API_VERSION }) });
      this.command(box, t("upgradeCommand"));
    } else {
      box.createEl("p", { text: t("engineNotFound") });
      this.command(box, t("installCommand"));
      if (s.reason && s.state === "offline") box.createEl("pre", { cls: "trova-reason", text: s.reason });
    }
    buttons.createEl("button", { text: t("checkAgain") }).addEventListener("click", () => void engine.connect(true));
    buttons.createEl("button", { text: t("continueWithout"), cls: "mod-cta" }).addEventListener("click", withoutEngine);
  }
}
