// The footer panel: an optional strip under the editor with the top five connections for the
// block being edited.

import { showPanel, type EditorView, type Panel, type ViewUpdate } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { t } from "../i18n/en.js";
import type TrovaPlugin from "../main.js";
import { labelText, onOpen } from "../ui.js";
import { sectionAt } from "../views/ConnectionsView.js";

const REFRESH_MS = 800;

export function footerExtension(plugin: TrovaPlugin) {
  return showPanel.of((view: EditorView): Panel => {
    const dom = document.createElement("div");
    dom.className = "trova-footer";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abort: AbortController | null = null;
    let lastKey = "";

    const load = async () => {
      if (!plugin.settings.footerPanel || !plugin.engine.ready) {
        dom.style.display = "none";
        lastKey = "";
        return;
      }
      const file = view.state.field(editorInfoField, false)?.file;
      if (!file || file.extension !== "md") return void (dom.style.display = "none");
      const line = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
      const cache = plugin.app.metadataCache.getFileCache(file);
      const section = sectionAt((cache?.headings ?? []).map((h) => ({ heading: h.heading, level: h.level, line: h.position.start.line })), line);
      const key = `${file.path}#${section.headingPath}`;
      if (key === lastKey) return;
      lastKey = key;
      abort?.abort();
      abort = new AbortController();
      const signal = abort.signal;
      const result = await plugin.connections.related({ kind: "block", path: file.path, ...section }, signal, 8).catch(() => null);
      if (signal.aborted) return;
      dom.replaceChildren();
      const top = (result?.state === "ok" ? result.results : []).slice(0, 5);
      if (top.length === 0) return void (dom.style.display = "none");
      dom.style.display = "";
      const label = document.createElement("span");
      label.className = "trova-footer-label";
      label.textContent = t("connectionsTitle");
      dom.appendChild(label);
      for (const r of top) {
        const chip = document.createElement("button");
        chip.className = `trova-footer-chip trova-label-${r.label}`;
        chip.textContent = r.title;
        chip.setAttribute("aria-label", `${r.title} (${labelText(r.label)})`);
        onOpen(chip, (where) => void plugin.openResult(r.blocks?.[0] ?? r, where));
        dom.appendChild(chip);
      }
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), REFRESH_MS);
    };
    dom.style.display = "none";
    schedule();
    return {
      dom,
      top: false,
      update(u: ViewUpdate) {
        if (u.selectionSet || u.docChanged) schedule();
      },
      destroy() {
        if (timer) clearTimeout(timer);
        abort?.abort();
      },
    };
  });
}
