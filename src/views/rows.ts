// Pieces shared by the rows of the Connections pane: the strength meter and keyboard movement
// between rows.

import type { Label } from "@trova/contract";
import { t } from "../i18n/en.js";
import { labelText } from "../ui.js";

/** How many of the meter's three bars a label fills. */
export function strengthLevel(label: Label): 1 | 2 | 3 {
  return label === "strong" ? 3 : label === "related" ? 2 : 1;
}

/**
 * A three-bar meter in the accent colour. The number of filled bars carries the level, so it
 * reads without colour; the accessible name carries the label and, when known, the similarity.
 */
export function renderMeter(parent: HTMLElement, label: Label, similarity?: number): HTMLElement {
  const name = similarity === undefined ? labelText(label) : `${labelText(label)} · ${t("whySimilarity", { score: similarity.toFixed(2) })}`;
  const meter = parent.createSpan({ cls: "trova-meter3", attr: { role: "img", "aria-label": name, "data-level": String(strengthLevel(label)) } });
  for (let i = 1; i <= 3; i++) meter.createSpan({ cls: "trova-meter3-bar" });
  return meter;
}

/** The rows a list offers to the keyboard, in order. */
function rowsIn(list: HTMLElement): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>("[data-row]")];
}

/** Moves focus to the row `step` rows away from `from`, staying at the ends. */
export function moveFocus(list: HTMLElement, from: HTMLElement | null, step: number): HTMLElement | null {
  const rows = rowsIn(list);
  if (rows.length === 0) return null;
  const at = from ? rows.indexOf(from) : -1;
  const next = rows[at === -1 ? (step > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + step))]!;
  next.focus();
  next.scrollIntoView({ block: "nearest" });
  return next;
}
