import { build, context } from "esbuild";
import { builtinModules } from "node:module";

const production = process.argv[2] === "production";

// The worker is bundled first, to a string. main.js starts it from a Blob URL, so the plugin
// ships as one main.js.
async function workerCode() {
  const result = await build({
    entryPoints: ["src/worker/worker.ts"],
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
    minify: production,
    logLevel: "warning",
  });
  return result.outputFiles[0].text;
}

const inlineWorker = {
  name: "inline-worker",
  setup(b) {
    b.onResolve({ filter: /^virtual:worker-code$/ }, (args) => ({ path: args.path, namespace: "worker-code" }));
    b.onLoad({ filter: /.*/, namespace: "worker-code" }, async () => ({
      contents: `export default ${JSON.stringify(await workerCode())};`,
      loader: "js",
      watchDirs: ["src/worker", "../contract/src"],
    }));
  },
};

const options = {
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  target: "es2022",
  platform: "browser",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  plugins: [inlineWorker],
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  logLevel: "info",
};

if (production) await build(options);
else {
  const ctx = await context(options);
  await ctx.watch();
}
