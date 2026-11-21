import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    pool: "forks",
  },
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./test/obsidian-mock.ts", import.meta.url)),
    },
  },
});
