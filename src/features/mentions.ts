// Unlinked mentions: notes that name a note, or one of its aliases, without linking to it. The
// Connections pane lists them for the active note; linking is always an explicit user action.

import { TFile } from "obsidian";
import { t } from "../i18n/en.js";
import type TrovaPlugin from "../main.js";
import { ConfirmModal, undoNotice } from "../ui.js";
import type { MentionHit } from "../worker/index.js";

/** The notes that mention `file` without linking to it. An error or an abort returns no hits. */
export async function findMentions(plugin: TrovaPlugin, file: TFile, signal?: AbortSignal): Promise<MentionHit[]> {
  const doc = plugin.indexer.docFor(file);
  return plugin.worker.call("mentions", [[doc.title, ...doc.aliases], file.path], signal).catch(() => [] as MentionHit[]);
}

/** The number of separate mentions in a list of hits. */
export function mentionCount(hits: MentionHit[]): number {
  return hits.reduce((n, h) => n + h.mentions.length, 0);
}

/**
 * "Link all": more than one note changes, so the exact edits are listed and the user confirms
 * first. `done` runs after the edits.
 */
export function confirmLinkAll(plugin: TrovaPlugin, target: TFile, hits: MentionHit[], done: () => void): void {
  const title = plugin.indexer.docFor(target).title;
  const lines = hits.flatMap((h) => h.mentions.map((m) => `${h.path}: "${m.name}" → [[${title}${m.name === title ? "" : `|${m.name}`}]]`));
  new ConfirmModal(plugin.app, t("confirmTitle"), t("confirmBody"), lines, t("confirm"), () => void linkMentions(plugin, target, hits, done).then(done)).open();
}

/**
 * Replaces mentions with links. Each file is edited once, from its last mention to its first.
 * Undo restores every edited file; `afterUndo` runs once the files are restored.
 */
export async function linkMentions(plugin: TrovaPlugin, target: TFile, hits: MentionHit[], afterUndo: () => void): Promise<void> {
  const { app } = plugin;
  const undo: { file: TFile; before: string }[] = [];
  let edits = 0;
  for (const hit of hits) {
    const file = app.vault.getAbstractFileByPath(hit.path);
    if (!(file instanceof TFile)) continue;
    let before = "";
    await app.vault.process(file, (content) => {
      before = content;
      let next = content;
      for (const m of [...hit.mentions].sort((a, b) => b.start - a.start)) {
        // The file may have changed since the scan; edit only where the text still matches.
        if (next.slice(m.start, m.end) !== m.name) continue;
        const link = app.fileManager.generateMarkdownLink(target, file.path, undefined, m.name === target.basename ? undefined : m.name);
        next = next.slice(0, m.start) + link + next.slice(m.end);
        edits++;
      }
      return next;
    });
    undo.push({ file, before });
  }
  if (edits === 0) return;
  undoNotice(edits === 1 ? t("linked") : t("editsApplied", { n: edits }), () => {
    for (const u of undo) void app.vault.modify(u.file, u.before);
    window.setTimeout(afterUndo, 300);
  });
}
