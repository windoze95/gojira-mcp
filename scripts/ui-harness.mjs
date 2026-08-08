/**
 * Serves the local MCP Apps render harness: bundles ui/harness/host.ts and
 * serves it alongside the built templates in ui/dist.
 *
 *   npm run ui:harness   →   http://localhost:5174/
 *
 * The harness implements the host side of the MCP Apps bridge with fixture
 * data (ui/harness/fixtures.ts), so every view — including its interactive
 * paths — renders without a tenant, OAuth, or Redis.
 */
import { context } from "esbuild";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.HARNESS_PORT ?? 5174);

const ctx = await context({
  entryPoints: [join(root, "ui", "harness", "host.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  outfile: join(root, "ui", "harness", "host.js"),
  sourcemap: "inline",
  logLevel: "info",
});
await ctx.rebuild();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  let path = decodeURIComponent(url.pathname);
  if (path === "/" || path === "") path = "/index.html";

  // Templates are served from ui/dist, everything else from ui/harness.
  const base = path.startsWith("/dist/") ? join(root, "ui") : join(root, "ui", "harness");
  const rel = path.startsWith("/dist/") ? path : path;
  const file = normalize(join(base, rel));
  if (!file.startsWith(join(root, "ui"))) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    let body = await readFile(file);
    if (extname(file) === ".html") {
      // Dev-only: opt out of Dark Reader-style extensions so the harness shows
      // the host-provided theme rather than an extension's recolor. Injected on
      // the way out — the shipped templates in ui/dist stay untouched.
      body = Buffer.from(
        body.toString("utf8").replace(/<head>/i, '<head>\n<meta name="darkreader-lock">'),
      );
    }
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`\n  MCP Apps harness → http://localhost:${PORT}/\n`);
  console.log("  (build templates first with `npm run build:ui`)\n");
});

process.on("SIGINT", async () => {
  await ctx.dispose();
  server.close();
  process.exit(0);
});
