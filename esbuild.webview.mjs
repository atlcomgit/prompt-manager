import * as esbuild from "esbuild";
import path from "path";

const isWatch = process.argv.includes("--watch");

const webviewEntries = [
  {
    entry: "src/webview/sidebar/index.tsx",
    outfile: "dist/webview/sidebar.js",
  },
  { entry: "src/webview/editor/index.tsx", outfile: "dist/webview/editor.js" },
  {
    entry: "src/webview/reportEditor/index.tsx",
    outfile: "dist/webview/reportEditor.js",
  },
  {
    entry: "src/webview/statistics/index.tsx",
    outfile: "dist/webview/statistics.js",
  },
  {
    entry: "src/webview/tracker/index.tsx",
    outfile: "dist/webview/tracker.js",
  },
  {
    entry: "src/webview/copilotUsage/index.tsx",
    outfile: "dist/webview/copilotUsage.js",
  },
];

const buildOptions = webviewEntries.map(({ entry, outfile }) => ({
  entryPoints: [entry],
  bundle: true,
  outfile,
  format: "iife",
  platform: "browser",
  target: "es2020",
  sourcemap: isWatch,
  minify: !isWatch,
  define: {
    "process.env.NODE_ENV": isWatch ? '"development"' : '"production"',
  },
  loader: {
    ".tsx": "tsx",
    ".ts": "ts",
    ".css": "css",
    ".svg": "text",
  },
}));

async function main() {
  if (isWatch) {
    const contexts = await Promise.all(
      buildOptions.map((opts) => esbuild.context(opts)),
    );
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("[webview] Watching for changes...");
  } else {
    await Promise.all(buildOptions.map((opts) => esbuild.build(opts)));
    console.log("[webview] Build complete.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
