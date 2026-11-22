import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  // Build output and Node build scripts are not plugin code. The test vault holds a copy of main.js.
  globalIgnores(["node_modules", "main.js", "esbuild.config.mjs", "version-bump.mjs", "vitest.config.mts", "test-vault"]),
  ...obsidianmd.configs.recommended,
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
