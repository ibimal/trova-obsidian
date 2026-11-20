// The Context basket view: reorder by dragging, watch the size meter, and copy in one click.

import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type { ContextFormat } from "@trova/contract";
import { t } from "../i18n/en.js";
import type TrovaPlugin from "../main.js";
import { folderOf, onOpen, undoNotice } from "../ui.js";

export const BASKET_VIEW = "trova-basket";

export class BasketView extends ItemView {
  private meterEl!: HTMLElement;
  private listEl!: HTMLElement;
  private actionsEl!: HTMLElement;
  private dragFrom = -1;
  private tokenRun = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: TrovaPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return BASKET_VIEW;
  }
  getDisplayText(): string {
    return t("basketTitle");
  }
  override getIcon(): string {
    return "shopping-basket";
  }

  override async onOpen(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.addClass("trova-pane");
    this.meterEl = el.createDiv({ cls: "trova-meter", attr: { "aria-live": "polite" } });
    this.actionsEl = el.createDiv({ cls: "trova-basket-actions" });
    this.listEl = el.createDiv({ cls: "trova-pane-body", attr: { role: "list" } });
    this.register(this.plugin.basket.onChange(() => this.render()));
    this.render();
  }

  private render(): void {
    const { basket } = this.plugin;
    this.renderActions();
    void this.renderMeter();
    const list = this.listEl;
    list.empty();
    if (basket.items.length === 0) {
      list.createDiv({ cls: "trova-empty", text: t("basketEmpty") });
      return;
    }
    basket.items.forEach((item, index) => {
      const row = list.createDiv({ cls: "trova-basket-item", attr: { draggable: "true", role: "listitem", tabindex: "0" } });
      setIcon(row.createSpan({ cls: "trova-grip" }), "grip-vertical");
      const text = row.createDiv({ cls: "trova-basket-text" });
      text.createDiv({ cls: "trova-row-title", text: item.title });
      const detail = item.kind === "note" ? t("wholeNote") : `${item.headings?.join(" › ") || item.title}${item.kind === "neighbours" ? " ±1" : ""}`;
      text.createDiv({ cls: "trova-row-path", text: [folderOf(item.path), detail].filter(Boolean).join(" · ") });
      const remove = row.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("remove") } });
      setIcon(remove, "x");
      remove.addEventListener("click", (e) => {
        e.stopPropagation();
        const removed = basket.remove(item.key);
        if (removed) undoNotice(t("removed"), () => basket.restore(removed, index));
      });
      onOpen(text, (where) => void this.plugin.open({ path: item.path, headings: item.headings }, where));
      // Drag to reorder; the copy follows the basket order. Alt+Up and Alt+Down do the same from the keyboard.
      row.addEventListener("dragstart", (e) => {
        this.dragFrom = index;
        e.dataTransfer?.setData("text/plain", item.title);
        row.addClass("is-dragging");
      });
      row.addEventListener("dragend", () => row.removeClass("is-dragging"));
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        row.addClass("is-drop-target");
      });
      row.addEventListener("dragleave", () => row.removeClass("is-drop-target"));
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        if (this.dragFrom !== -1) basket.move(this.dragFrom, index);
        this.dragFrom = -1;
      });
      row.addEventListener("keydown", (e) => {
        if (e.altKey && e.key === "ArrowUp") basket.move(index, index - 1);
        else if (e.altKey && e.key === "ArrowDown") basket.move(index, index + 1);
        else if (e.key === "Delete" || e.key === "Backspace") remove.click();
      });
    });
  }

  private async renderMeter(): Promise<void> {
    const run = ++this.tokenRun;
    const tokens = await this.plugin.basket.tokens();
    if (run !== this.tokenRun) return;
    const limit = this.plugin.settings.contextWarnTokens;
    this.meterEl.empty();
    this.meterEl.createSpan({ text: t("basketTokens", { n: tokens.toLocaleString() }) });
    const bar = this.meterEl.createDiv({ cls: "trova-meter-bar" });
    bar.createDiv({ cls: "trova-meter-fill" }).style.width = `${Math.min(100, (tokens / Math.max(1, limit)) * 100)}%`;
    this.meterEl.toggleClass("is-over", tokens > limit);
    if (tokens > limit) this.meterEl.createSpan({ cls: "trova-meter-warn", text: t("basketOver", { limit: limit.toLocaleString() }) });
  }

  private renderActions(): void {
    const el = this.actionsEl;
    el.empty();
    const empty = this.plugin.basket.items.length === 0;
    const button = (label: string, run: (b: HTMLButtonElement) => void, cta = false) => {
      const b = el.createEl("button", { text: label, cls: cta ? "mod-cta" : "" });
      b.disabled = empty;
      b.addEventListener("click", () => run(b));
    };
    button(t("copyMarkdown"), (b) => void this.plugin.copyBasket("markdown", b), true);
    button(t("copyXml"), (b) => void this.plugin.copyBasket("xml", b));
    button(t("copyPlain"), (b) => void this.plugin.copyBasket("plain", b));
    button(t("saveAsNote"), (b) => void this.plugin.copyBasket("note", b));
    button(t("addLinked"), () => {
      const n = this.plugin.basket.addLinked();
      new Notice(`+${n}`);
    });
    button(t("clear"), () => {
      const old = this.plugin.basket.clear();
      undoNotice(t("removed"), () => this.plugin.basket.setAll(old));
    });
  }
}

export type { ContextFormat };
