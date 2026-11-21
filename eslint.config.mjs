import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  // Build output and Node build scripts are not plugin code. The test vault holds a copy of main.js.
  globalIgnores(["node_modules", "main.js", "esbuild.config.mjs", "vitest.config.mts", "test-vault"]),
  ...obsidianmd.configs.recommended,
  {
    // The contract and the search index run in the web worker, which has no window or document.
    // The contract is also shared with the engine, which runs on Node.
    files: ["src/contract/**", "src/worker/**"],
    rules: {
      "obsidianmd/no-global-this": "off",
      "obsidianmd/prefer-window-timers": "off",
      "obsidianmd/prefer-active-doc": "off",
    },
  },
  {
    // The engine client streams NDJSON and SSE responses and aborts them midway. Obsidian's
    // requestUrl returns only whole responses and cannot be aborted. The engine listens on
    // 127.0.0.1 and allows the app://obsidian.md origin.
    files: ["src/engine/client.ts"],
    rules: { "no-restricted-globals": "off" },
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
