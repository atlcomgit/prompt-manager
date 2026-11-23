import * as esbuild from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

const isWatch = process.argv.includes("--watch");

// node_modules is excluded from the VSIX. Preserve the licenses of exactly the packages in the lazy bundle.
const bashCodeNotices = {
  name: "bash-code-notices",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length) return;
      const packages = new Map();
      for (const input of Object.keys(result.metafile.inputs)) {
        const match = input.replaceAll("\\", "/").match(/^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//);
        if (match) packages.set(match[1], match[2]);
      }
      const notices = new Map();
      for (const [directory, name] of packages) {
        const license = (await readFile(`${directory}/LICENSE`, "utf8")).trim();
        if (!notices.has(license)) notices.set(license, []);
        notices.get(license).push(name);
      }
      const content = [...notices].map(([license, names]) => names.sort().join(", ") + "\n\n" + license);
      await writeFile("dist/bash-script-code-NOTICES.txt", content.join("\n\n") + "\n");
    });
  },
};

const webviewEntries = [
  {
    entry: "src/webview/sidebar/index.tsx",
    outfile: "dist/webview/sidebar.js",
  },
  { entry: "src/webview/editor/index.tsx", outfile: "dist/webview/editor.js" },
  {
    entry: "src/webview/editor/components/bashScripts/bashScriptCodeMirror.mts",
    outfile: "dist/webview/bashScriptCode.js",
    globalName: "promptManagerBashCode",
    metafile: true,
    plugins: [bashCodeNotices],
  },
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
  {
    entry: "src/webview/memory/index.tsx",
    outfile: "dist/webview/memory.js",
  },
  {
    entry: "src/webview/quickNotes/index.tsx",
    outfile: "dist/webview/quickNotes.js",
  },
];

const buildOptions = webviewEntries.map(({ entry, outfile, ...entryOptions }) => ({
  entryPoints: [entry],
  bundle: true,
  outfile,
  ...entryOptions,
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
