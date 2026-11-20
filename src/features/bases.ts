// Bases integration. Obsidian's Bases API (1.10) lets a plugin register a view, but not custom
// functions, so `trova_score()` and `trova_related()` ship as a Bases view with a Score
// column (similarity to the active note) and a Related column (top related notes per row).

import * as obsidian from "obsidian";
import type { TFile } from "obsidian";
import { onOpen } from "../ui.js";
import { t } from "../i18n/en.js";
import type TrovaPlugin from "../main.js";

const MAX_ROWS = 60;

interface BasesViewLike {
  data: { data: { file: TFile }[] };
  app: obsidian.App;
}

export function registerBases(plugin: TrovaPlugin): boolean {
  const BasesView = (obsidian as unknown as { BasesView?: abstract new (controller: unknown) => obsidian.Component & BasesViewLike }).BasesView;
  const register = (plugin as unknown as { registerBasesView?: (id: string, reg: unknown) => boolean }).registerBasesView;
  if (typeof BasesView !== "function" || typeof register !== "function") return false;

  class RelatedBasesView extends BasesView {
    type = "trova-related";
    private run = 0;
    constructor(
      controller: unknown,
      private el: HTMLElement,
    ) {
      super(controller);
    }

    onDataUpdated(): void {
      void this.render();
    }

    private async render(): Promise<void> {
      const run = ++this.run;
      const el = this.el;
      el.empty();
      el.addClass("trova-bases");
      if (!plugin.engine.ready) return void el.createDiv({ cls: "trova-empty", text: t("needsEngine") });
      const files = this.data.data.map((e) => e.file).filter((f) => f.extension === "md").slice(0, MAX_ROWS);
      const active = plugin.app.workspace.getActiveFile();
      const table = el.createEl("table", { cls: "trova-bases-table" });
      const head = table.createEl("thead").createEl("tr");
      for (const label of ["", t("basesScore"), t("basesRelated")]) head.createEl("th", { text: label });
      const body = table.createEl("tbody");
      const rows = files.map((file) => {
        const tr = body.createEl("tr");
        const name = tr.createEl("td").createEl("a", { text: file.basename, cls: "internal-link" });
        onOpen(name, (where) => void plugin.open({ path: file.path }, where));
        return { file, score: tr.createEl("td", { text: "…" }), related: tr.createEl("td", { text: "…" }) };
      });
      // trova_score(): similarity between each row and the active note, in one request.
      if (active && active.extension === "md") {
        const pairs = rows.map((r) => [{ source: plugin.sourceId(active.path) }, { source: plugin.sourceId(r.file.path) }] as [{ source: string }, { source: string }]);
        const scores = await plugin.engine.score({ pairs }).catch(() => null);
        if (run !== this.run) return;
        rows.forEach((r, i) => r.score.setText(scores?.scores[i] == null ? "–" : scores.scores[i]!.toFixed(2)));
      } else rows.forEach((r) => r.score.setText("–"));
      // trova_related(): the top related notes per row, one row at a time.
      for (const r of rows) {
        if (run !== this.run) return;
        const list = await plugin.api.related({ path: r.file.path }, { limit: 3 }).catch(() => []);
        if (run !== this.run) return;
        r.related.empty();
        list.slice(0, 3).forEach((rel, i) => {
          if (i > 0) r.related.appendText(", ");
          onOpen(r.related.createEl("a", { text: rel.title, cls: "internal-link" }), (where) => void plugin.openResult(rel, where));
        });
        if (list.length === 0) r.related.setText("–");
      }
    }
  }

  try {
    return register.call(plugin, "trova-related", {
      name: t("basesName"),
      icon: "waypoints",
      factory: (controller: unknown, containerEl: HTMLElement) => new RelatedBasesView(controller, containerEl),
    });
  } catch {
    return false;
  }
}
