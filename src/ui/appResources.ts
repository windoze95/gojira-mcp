import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

import { logger } from "../utils/logger.js";
import type { AnyToolDef } from "../tools/defs/defineTool.js";

/**
 * MCP Apps (SEP-1865) UI templates. Each entry is a self-contained HTML
 * bundle produced by `npm run build:ui` (scripts/build-ui.mjs) from the
 * browser sources in `ui/src/`, served to hosts as a `ui://` resource with
 * the `text/html;profile=mcp-app` MIME type.
 *
 * Tools opt in per-def via `ui: { resourceUri }`; destructive tools without
 * an explicit template get CONFIRM_OP_UI_URI so their dry-run payloads render
 * as a diff/confirm card (see resolveUiResourceUri).
 */
export const CONFIRM_OP_UI_URI = "ui://gojira/confirm-op.html";
export const JOURNAL_UI_URI = "ui://gojira/journal.html";
export const AQL_TABLE_UI_URI = "ui://gojira/aql-table.html";
export const AUTOMATION_RULE_UI_URI = "ui://gojira/automation-rule.html";

interface UiAsset {
  uri: string;
  file: string;
  name: string;
  description: string;
}

const UI_ASSETS: UiAsset[] = [
  {
    uri: CONFIRM_OP_UI_URI,
    file: "confirm-op.html",
    name: "Operation confirm card",
    description:
      "Renders commit-positive dry-runs as a diff card (RFC 6902 patch / before-after) with a commit action; also renders committed results and errors.",
  },
  {
    uri: JOURNAL_UI_URI,
    file: "journal.html",
    name: "Operation journal timeline",
    description:
      "Timeline of journaled operations with per-entry detail, before/after diff, and dry-run-first revert.",
  },
  {
    uri: AQL_TABLE_UI_URI,
    file: "aql-table.html",
    name: "Assets AQL results table",
    description:
      "Paged table over Assets (CMDB) AQL search results with dynamic attribute columns and a column picker.",
  },
  {
    uri: AUTOMATION_RULE_UI_URI,
    file: "automation-rule.html",
    name: "Automation rule inspector",
    description:
      "Automation rule list and trigger/conditions/actions tree view for a single rule.",
  },
];

const ASSET_BY_URI = new Map(UI_ASSETS.map((a) => [a.uri, a]));

function assetsDir(): string {
  // Override for tests and non-standard layouts; default is <repo>/ui/dist
  // relative to this module (src/ui/ → ../../ui/dist, same depth under dist/).
  return process.env.GOJIRA_UI_ASSETS_DIR ?? fileURLToPath(new URL("../../ui/dist", import.meta.url));
}

let availability: boolean | null = null;
let warnedUnavailable = false;
const htmlCache = new Map<string, string>();

/**
 * True when every UI template bundle exists on disk. Cached for the process
 * lifetime — sessions register per-connection and must not re-stat four files
 * each time. When false (and the flag is on), UI metadata and resources are
 * simply not registered; the server stays fully functional as text-only.
 */
export function uiAssetsAvailable(): boolean {
  if (availability !== null) return availability;
  const dir = assetsDir();
  availability = UI_ASSETS.every((a) => existsSync(join(dir, a.file)));
  if (!availability && !warnedUnavailable) {
    warnedUnavailable = true;
    logger.warn(
      { dir },
      "UI templates not found — run 'npm run build:ui' to enable MCP Apps rendering; continuing text-only",
    );
  }
  return availability;
}

export function resetUiAssetsCacheForTests(): void {
  availability = null;
  warnedUnavailable = false;
  htmlCache.clear();
}

function loadUiAssetHtml(asset: UiAsset): string {
  const path = join(assetsDir(), asset.file);
  const cached = htmlCache.get(path);
  if (cached !== undefined) return cached;
  const html = readFileSync(path, "utf8");
  htmlCache.set(path, html);
  return html;
}

/**
 * The UI template a tool renders with, or null for text-only tools.
 * Explicit `def.ui` wins; destructive tools default to the confirm card so
 * every commit-positive dry-run gets the diff/confirm treatment.
 */
export function resolveUiResourceUri(def: AnyToolDef): string | null {
  if (def.ui?.resourceUri) return def.ui.resourceUri;
  if (def.destructive) return CONFIRM_OP_UI_URI;
  return null;
}

/**
 * Registers the UI resources referenced by this session's registered tools.
 * Only referenced templates are exposed — a deployment without the assets
 * groups, say, never lists the AQL table.
 */
export function registerUiResources(server: McpServer, defs: AnyToolDef[]): string[] {
  const uris = new Set<string>();
  for (const def of defs) {
    const uri = resolveUiResourceUri(def);
    if (uri) uris.add(uri);
  }
  const registered: string[] = [];
  for (const uri of uris) {
    const asset = ASSET_BY_URI.get(uri);
    if (!asset) {
      // A def references a template this build doesn't ship — misconfiguration,
      // not a crash: the host just gets no renderable resource for it.
      logger.warn({ uri }, "Tool references an unknown UI resource URI; skipping registration");
      continue;
    }
    registerAppResource(
      server,
      asset.name,
      asset.uri,
      {
        description: asset.description,
        _meta: { ui: { prefersBorder: true } },
      },
      async () => ({
        contents: [
          {
            uri: asset.uri,
            mimeType: RESOURCE_MIME_TYPE,
            text: loadUiAssetHtml(asset),
          },
        ],
      }),
    );
    registered.push(uri);
  }
  return registered;
}
