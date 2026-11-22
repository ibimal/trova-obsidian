// Lints styles.css as Obsidian's plugin review does: no !important, and features the target
// Chromium supports. The review reports against an older Obsidian than the current one, because
// Obsidian runs on whatever Chromium the user's installer shipped; "Chrome >= 130" reproduces its
// findings. stylelint-config-recommended adds checks for genuine CSS mistakes.
export default {
  extends: ["stylelint-config-recommended"],
  plugins: ["stylelint-no-unsupported-browser-features"],
  rules: {
    // A source-order heuristic, not part of Obsidian's review. Satisfying it would mean reordering
    // much of the stylesheet, with real risk of changing how things look.
    "no-descending-specificity": null,
    "declaration-no-important": [
      true,
      { message: "Avoid !important: use a more specific selector or a CSS variable instead." },
    ],
    "plugin/no-unsupported-browser-features": [
      true,
      { browsers: ["Chrome >= 130"], severity: "warning" },
    ],
  },
};
