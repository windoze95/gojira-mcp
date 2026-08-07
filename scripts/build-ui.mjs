/**
 * Bundles the MCP Apps views in ui/src/ into self-contained single-file HTML
 * documents in ui/dist/ — one per template, CSS and JS inlined, no external
 * requests (hosts sandbox the iframe with a deny-all CSP by default).
 *
 * Server-side counterpart: src/ui/appResources.ts serves these files as
 * ui://gojira/<name>.html resources.
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRIES = ["confirm-op", "journal", "aql-table", "automation-rule"];

const outDir = join(root, "ui", "dist");
mkdirSync(outDir, { recursive: true });

const css = readFileSync(join(root, "ui", "src", "shared", "base.css"), "utf8");

for (const name of ENTRIES) {
  const result = await build({
    entryPoints: [join(root, "ui", "src", `${name}.ts`)],
    bundle: true,
    minify: true,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    write: false,
    sourcemap: false,
    legalComments: "none",
  });
  // "</script>" inside string literals would terminate the inline script tag.
  const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
${css}</style>
</head>
<body>
<main id="app" aria-busy="true"></main>
<script>
${js}</script>
</body>
</html>
`;
  const outPath = join(outDir, `${name}.html`);
  writeFileSync(outPath, html);
  console.log(`ui/dist/${name}.html  ${(html.length / 1024).toFixed(1)} KB`);
}
