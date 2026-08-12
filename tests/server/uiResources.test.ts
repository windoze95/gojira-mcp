import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerSessionTools } from "../../src/tools/registry.js";
import { OUTPUT_ENVELOPE_SHAPE } from "../../src/tools/wrapHandler.js";
import {
  AQL_TABLE_UI_URI,
  CONFIRM_OP_UI_URI,
  JOURNAL_UI_URI,
  REQUEST_BUILD_UI_URI,
  resetUiAssetsCacheForTests,
} from "../../src/ui/appResources.js";
import type { ToolDeps } from "../../src/tools/types.js";

const UI_FILES = ["confirm-op.html", "journal.html", "aql-table.html", "automation-rule.html", "request-build.html"];

function makeDeps(uiEnabled: boolean): ToolDeps {
  return {
    config: {
      enabledGroups: ["utility", "read_jsm_admin", "read_assets", "read_automation", "delete_projects"],
      orgAdmin: { enabled: false, orgId: null },
      ui: { enabled: uiEnabled },
    },
    rateLimiter: {},
    audit: { emit: () => {} },
    usageMetrics: { record: () => {} },
    journal: {},
  } as unknown as ToolDeps;
}

async function connectedClient(deps: ToolDeps): Promise<Client> {
  const server = new McpServer({ name: "gojira-mcp-test", version: "0.0.0" });
  registerSessionTools(server, deps, { clientId: "test-client" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("MCP Apps resources + tool metadata (end-to-end over a real session)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gojira-ui-"));
    for (const f of UI_FILES) writeFileSync(join(dir, f), `<!doctype html><title>${f}</title>`);
    process.env.GOJIRA_UI_ASSETS_DIR = dir;
    resetUiAssetsCacheForTests();
  });

  afterEach(() => {
    delete process.env.GOJIRA_UI_ASSETS_DIR;
    resetUiAssetsCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("links templates on tools and serves only the referenced ui:// resources", async () => {
    const client = await connectedClient(makeDeps(true));

    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    // Destructive default → confirm card; explicit def.ui → its own template.
    const del = byName.get("projects.delete")!;
    expect(del._meta?.ui).toEqual({ resourceUri: CONFIRM_OP_UI_URI });
    expect(del._meta?.["ui/resourceUri"]).toBe(CONFIRM_OP_UI_URI);
    expect(del.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });

    expect(byName.get("assets.aqlSearch")!._meta?.ui).toEqual({ resourceUri: AQL_TABLE_UI_URI });
    expect(byName.get("gojira.readJournal")!._meta?.ui).toEqual({ resourceUri: JOURNAL_UI_URI });
    expect(byName.get("jsm.inspectRequestBuild")!._meta?.ui).toEqual({ resourceUri: REQUEST_BUILD_UI_URI });
    expect(byName.get("gojira.readJournal")!.annotations).toMatchObject({ readOnlyHint: true });

    // Read tool without a template: no UI meta at all.
    expect(byName.get("gojira.health")!._meta).toBeUndefined();

    // Every tool declares the output envelope.
    expect(byName.get("gojira.health")!.outputSchema).toBeDefined();

    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri).sort();
    expect(uris).toEqual(
      [CONFIRM_OP_UI_URI, JOURNAL_UI_URI, AQL_TABLE_UI_URI, REQUEST_BUILD_UI_URI, "ui://gojira/automation-rule.html"].sort(),
    );

    const read = await client.readResource({ uri: CONFIRM_OP_UI_URI });
    expect(read.contents[0]).toMatchObject({
      uri: CONFIRM_OP_UI_URI,
      mimeType: "text/html;profile=mcp-app",
    });
    expect(read.contents[0].text).toContain("confirm-op.html");
  });

  it("registers no UI metadata or resources when the flag is off", async () => {
    const client = await connectedClient(makeDeps(false));
    const { tools } = await client.listTools();
    for (const t of tools) expect(t._meta).toBeUndefined();
    // With no resources registered the SDK may not advertise the capability at
    // all — either an empty list or a method-not-supported error is correct.
    const resources = await client.listResources().then(
      (r) => r.resources,
      () => [],
    );
    expect(resources).toEqual([]);
  });

  it("registers nothing UI-related when template bundles are missing", async () => {
    rmSync(join(dir, "journal.html"));
    resetUiAssetsCacheForTests();
    const client = await connectedClient(makeDeps(true));
    const { tools } = await client.listTools();
    for (const t of tools) expect(t._meta).toBeUndefined();
  });

  it("success envelopes pass the SDK's output-schema validation end-to-end", async () => {
    // Every tool declares OUTPUT_ENVELOPE_SHAPE, so the SDK validates each
    // successful result's structuredContent against it. A mismatch here would
    // break every successful call on every tool — exercise the exact
    // schema/payload pairing through a real server+client round trip.
    const server = new McpServer({ name: "t", version: "0.0.0" });
    const payload = {
      success: true,
      result: { nested: { deep: true }, list: [1, "x", null], value: "ok" },
    };
    server.registerTool(
      "test.echo",
      { description: "echo", inputSchema: {}, outputSchema: OUTPUT_ENVELOPE_SHAPE },
      async () => ({
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
      }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({ name: "test.echo", arguments: {} });
    expect(res.isError ?? false).toBe(false);
    expect(res.structuredContent).toEqual(payload);
  });
});
