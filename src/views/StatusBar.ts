// The status bar item and its popover. Trova always says what it is doing.

import { Notice, setIcon } from "obsidian";
import type { EngineSnapshot } from "../engine/manager.js";
import { t } from "../i18n/en.js";
import type TrovaPlugin from "../main.js";

export type StatusKind = "ready" | "progress" | "model" | "paused" | "off" | "error";

export interface StatusLine {
  kind: StatusKind;
  text: string;
}

/** The status bar text for an engine snapshot and the worker's indexing progress. */
export function statusLine(s: EngineSnapshot, worker: { done: number; total: number; running: boolean }, engineWanted: boolean): StatusLine {
  const n = (v: number) => v.toLocaleString("en-US");
  if (s.state === "disabled" || (!engineWanted && s.state !== "ready")) {
    if (worker.running) return { kind: "progress", text: t("stProgress", { done: n(worker.done), total: n(worker.total) }) };
    return { kind: "ready", text: t("stReady") };
  }
  if (s.state === "offline" || s.state === "not-found" || s.state === "wrong-version") return { kind: "off", text: t("stOff") };
  if (s.error) return { kind: "error", text: t("stError") };
  const models = s.status?.models;
  const downloading = models ? [models.embed, models.rerank, models.expand].find((m) => m.state === "downloading") : undefined;
  if (downloading) return { kind: "model", text: downloading.progress !== undefined ? t("stModel", { pct: Math.round(downloading.progress * 100) }) : t("stModelNoPct") };
  if (s.status?.paused) return { kind: "paused", text: t("stPaused") };
  if (s.progress && s.progress.total > 0 && s.progress.done < s.progress.total) return { kind: "progress", text: t("stProgress", { done: n(s.progress.done), total: n(s.progress.total) }) };
  if (worker.running) return { kind: "progress", text: t("stProgress", { done: n(worker.done), total: n(worker.total) }) };
  return { kind: "ready", text: t("stReady") };
}

export class StatusBar {
  private popover: HTMLElement | null = null;
  private closer = (e: MouseEvent) => {
    if (this.popover && !this.popover.contains(e.target as Node) && !this.el.contains(e.target as Node)) this.close();
  };

  constructor(
    private plugin: TrovaPlugin,
    private el: HTMLElement,
  ) {
    el.addClass("mod-clickable", "trova-status");
    el.setAttr("role", "button");
    el.setAttr("tabindex", "0");
    el.addEventListener("click", () => (this.popover ? this.close() : this.open()));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") this.popover ? this.close() : this.open();
      if (e.key === "Escape") this.close();
    });
    this.update();
  }

  line(): StatusLine {
    return statusLine(this.plugin.engine.snapshot, this.plugin.indexer.progress, this.plugin.engineWanted());
  }

  update(): void {
    const line = this.line();
    this.el.setText(line.text);
    this.el.dataset["state"] = line.kind;
    if (this.popover) this.renderPopover();
  }

  private open(): void {
    this.popover = document.body.createDiv({ cls: "trova-popover popover", attr: { role: "dialog" } });
    this.popover.setAttr("aria-labelledby", "trova-status-title");
    this.renderPopover();
    const rect = this.el.getBoundingClientRect();
    this.popover.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    this.popover.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    document.addEventListener("mousedown", this.closer, true);
    void this.plugin.engine.refreshStatus();
  }

  close(): void {
    this.popover?.remove();
    this.popover = null;
    document.removeEventListener("mousedown", this.closer, true);
  }

  private renderPopover(): void {
    const el = this.popover!;
    el.empty();
    const { engine, indexer } = this.plugin;
    const s = engine.snapshot;
    const line = this.line();
    el.createDiv({ cls: "trova-why-title", text: line.text, attr: { id: "trova-status-title" } });
    const row = (text: string) => el.createDiv({ cls: "trova-popover-row", text });
    const actions = el.createDiv({ cls: "trova-popover-actions" });
    const button = (label: string, icon: string, run: () => void) => {
      const b = actions.createEl("button");
      setIcon(b.createSpan(), icon);
      b.appendText(` ${label}`);
      b.addEventListener("click", run);
    };
    const status = s.status;
    if (status && engine.ready) {
      for (const c of status.collections) {
        row(`${c.name === this.plugin.collection ? this.plugin.app.vault.getName() : c.name}: ${t("popSources", { n: c.sources.toLocaleString(), e: c.embedded.toLocaleString() })}`);
        row(t("popLastIndex", { when: c.lastIndexed ? new Date(c.lastIndexed).toLocaleString() : t("popNever") }));
        if (c.oversized?.length) row(t("popOversized", { n: c.oversized.length }));
      }
      row(t("popModel", { id: status.models.embed.id ?? "?", state: status.models.embed.state }));
      row(t("popEngine", { name: status.engine.name, version: status.engine.version, backend: status.engine.backend }));
      if (status.reembedding) row(t("reembedding", { pct: Math.round((status.reembedding.done / Math.max(1, status.reembedding.total)) * 100) }));
      if (line.kind === "paused") button(t("resume"), "play", () => void engine.setPaused(false));
      else if (line.kind === "progress") button(t("pause"), "pause", () => void engine.setPaused(true));
      const job = status.jobs.find((j) => j.kind === "models");
      if (line.kind === "model" && job) button(t("cancel"), "x", () => void engine.cancelJob(job.jobId).then(() => engine.refreshStatus()));
    } else {
      row(t("popWorker", { n: indexer.progress.total.toLocaleString() }));
    }
    if (line.kind === "off") {
      if (s.reason) row(t("popReason", { reason: s.reason }));
      button(t("startEngine"), "play", () => void engine.connect(true));
    }
    if (line.kind === "error") {
      row(s.error ?? "");
    }
    if (line.kind === "error" || line.kind === "off") {
      button(t("copyDebug"), "copy", () => {
        const info = { plugin: this.plugin.manifest.version, state: s.state, reason: s.reason, error: s.error, status: s.status, worker: indexer.progress, platform: navigator.userAgent };
        void navigator.clipboard.writeText(JSON.stringify(info, null, 2));
        new Notice(t("debugCopied"));
      });
    }
    if (actions.childElementCount === 0) actions.remove();
  }
}
