# MCP Apps UI

gojira-mcp implements the [MCP Apps extension](https://modelcontextprotocol.io/extensions/apps)
(`io.modelcontextprotocol/ui`, SEP-1865 — Final since 2026-01-26): selected
tools link an HTML template via `_meta.ui.resourceUri`, the template is served
as a `ui://` resource with MIME `text/html;profile=mcp-app`, and UI-capable
hosts render it in a sandboxed iframe wired to the tool call. Hosts that don't
speak the extension ignore the metadata entirely — every tool result remains a
readable `{success, result|error}` JSON text block (now mirrored into
`structuredContent`).

Renders in: claude.ai web, Claude Desktop, Claude iOS/Android, ChatGPT
(developer mode / workspace connectors), VS Code Copilot, and other MCP Apps
hosts. Notably **not** Claude Code — CLI/IDE chat stays text-only.

## The four templates

| Template | Attached to | What it does |
|---|---|---|
| `ui://gojira/confirm-op.html` | **every destructive tool** (default; see below) | Renders the commit-positive dry-run as a diff card — RFC 6902 patch rows and/or before/after panes, target line, danger styling for permanent deletes — with a **Commit** button that re-invokes the same tool with the original arguments plus `commit: true`. Also renders committed results and error envelopes. |
| `ui://gojira/journal.html` | `gojira.listRecentOperations`, `gojira.getOperation` | Operation timeline with expandable detail (client-computed before/after patch) and a dry-run-first **Revert** flow for revertible entries. |
| `ui://gojira/aql-table.html` | `assets.aqlSearch` | Results table with dynamic attribute columns (from `objectTypeAttributes`), a column picker, per-page sort, and Prev/Next paging via re-invocation. |
| `ui://gojira/automation-rule.html` | `automation.listAutomationRules`, `automation.getAutomationRule` | Rule list (cursor paging) and trigger → conditions/branches → actions tree with raw value expanders. |

## How it's wired

- **Tool linkage** — `src/tools/wrapHandler.ts` adds, per tool:
  `outputSchema` (the loose `{success, result?, error?}` envelope),
  `structuredContent` on every result, truthful `annotations`
  (`destructiveHint` from `def.destructive`, `readOnlyHint` from a
  conservative read-verb allowlist), and — when UI is active —
  `_meta.ui.resourceUri` plus the deprecated flat `ui/resourceUri` alias for
  older hosts.
- **Template selection** — `src/ui/appResources.ts#resolveUiResourceUri`:
  explicit `def.ui.resourceUri` wins; otherwise `destructive: true` defaults
  to the confirm card; otherwise no UI.
- **Resource serving** — `registerUiResources` (called from
  `registerSessionTools`) registers only the templates actually referenced by
  the session's registered tools, so a deployment without `read_assets` never
  lists the AQL table.
- **Gating** — one switch: `GOJIRA_UI_ENABLED` (default on) **and** the
  presence of the built bundles in `ui/dist/`. Missing bundles log a single
  warning and the server runs text-only. `GOJIRA_UI_ASSETS_DIR` overrides the
  bundle directory (tests use this).

## The views

Browser sources live in `ui/src/` (TypeScript, no framework), built by
`scripts/build-ui.mjs` (esbuild) into self-contained single-file HTML in
`ui/dist/` — CSS and JS inlined, zero external requests, so the host's
deny-all CSP needs no exceptions. `npm run build` produces them; the Docker
image ships them.

Shared plumbing (`ui/src/shared/`):

- `host.ts` — bootstraps `@modelcontextprotocol/ext-apps`'s `App`
  (postMessage JSON-RPC bridge), applies host theme + MCP Apps style tokens
  (`--color-*`, `--font-*` … consumed with our palette as fallback), exposes
  `callTool` and a best-effort `updateModelContext` so the conversation model
  learns when a user commits or reverts from the view.
- `envelope.ts` — parses the gojira result envelope from
  `structuredContent` (fallback: first text block).
- `jsondiff.ts` — client-side port of `src/consent/jsonPatch.ts` so journal
  before/after pairs render the same diff the server produces at dry-run time.
- `dom.ts` / `render.ts` — DOM helpers (everything renders through
  `textContent`; upstream Atlassian data can never inject markup) and the
  shared patch-table / target / error / result renderers.

## Security posture

- Views are static HTML served from the MCP session itself; no external
  origins are declared in `_meta.ui.csp`, so hosts apply their default
  deny-all sandbox.
- The commit path goes through the normal tool pipeline — auth, rate limit,
  group allowlist, site pinning, journal, audit — because the view can only
  call `tools/call` back through the host; there is no side channel.
- `gojira.bindApiToken` deliberately has **no** UI: secret entry does not
  belong in a hosted iframe.

## Verifying locally

```bash
npm run build:ui && npm run dev
# then render the views with one of:
#  - the basic-host reference host from the modelcontextprotocol/ext-apps repo
#    (SERVERS='["http://localhost:8081/mcp"]' npm start)
#  - MCPJam / Postman (both render MCP Apps)
#  - claude.ai custom connector via an HTTPS tunnel to this server
```

The e2e rig (`npm run e2e`) exercises the dry-run→commit round trip the
confirm card drives; `tests/server/uiResources.test.ts` asserts the
tool-metadata and resource contract over a real in-memory MCP session.
