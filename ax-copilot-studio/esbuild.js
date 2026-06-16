// Bundles the extension host (Node target) and the webview UI (browser
// target) with esbuild. Two separate bundles: the host speaks `vscode` APIs
// directly, the webview is sandboxed browser JS loaded via panel.ts.
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ["src/webview/ui/main.ts"],
  bundle: true,
  outfile: "dist/webview/main.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

function copyWebviewStyles() {
  const outDir = path.join(__dirname, "dist", "webview");
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "src", "webview", "ui", "styles.css"),
    path.join(outDir, "styles.css"),
  );
}

async function run() {
  if (watch) {
    const [extensionCtx, webviewCtx] = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(webviewConfig),
    ]);
    copyWebviewStyles();
    await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
    console.log("[esbuild] watching for changes...");
  } else {
    await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
    copyWebviewStyles();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
