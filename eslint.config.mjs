import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

const STYLE_LITERAL = {
  selector: "AssignmentExpression[left.object.property.name='style'][right.type='Literal']",
  message:
    "Don't assign a fixed value to an element's style. Use a CSS class or setCssProps, and style.removeProperty() to clear a property.",
};
const BARE_TIMER = {
  selector:
    "CallExpression[callee.type='Identifier'][callee.name=/^(set|clear)(Timeout|Interval)$/]",
  message:
    "In the worker, call the timers through its scope object, for example scope.setTimeout().",
};

export default defineConfig([
  // Build output and Node build scripts are not plugin code. The test vault holds a copy of main.js.
  globalIgnores([
    "node_modules",
    "main.js",
    "esbuild.config.mjs",
    "stylelint.config.mjs",
    "version-bump.mjs",
    "vitest.config.mts",
    "test-vault",
  ]),
  ...obsidianmd.configs.recommended,
  // Stricter than the published rules, as Obsidian's plugin review is: assigning any literal to an
  // element's style, even "" to clear it, counts as setting a static style.
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", STYLE_LITERAL],
    },
  },
  // The review also asks for window timers in the worker, which has no window: call the
  // worker's own timers through its scope object.
  {
    files: ["src/worker/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", STYLE_LITERAL, BARE_TIMER],
    },
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*"],
        },
      },
    },
  },
]);
