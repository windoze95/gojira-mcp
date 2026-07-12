import { describe, expect, it, beforeAll } from "vitest";
import { buildHarness, noCreds } from "./harness.js";
import type { E2EHarness } from "./harness.js";

// Unique per run — Confluence space deletion is async (trash), so a fixed key
// collides with the previous run's not-yet-purged space.
const KEY = `GJE2E${Date.now().toString(36).toUpperCase()}`;

describe.skipIf(noCreds)("e2e: Confluence admin", () => {
  let h: E2EHarness;
  beforeAll(() => {
    h = buildHarness();
  });

  it("space lifecycle: create → get → update → permissions → delete", async () => {
    const created = await h.call<{ ok: boolean; space: { id: string | number } }>(
      "confluence.createConfluenceSpace",
      { key: KEY, name: "gojira-e2e-space", commit: true },
    );
    expect(created.ok).toBe(true);

    const spaces = await h.call<{ results: Array<{ id: string; name: string }> }>("confluence.listConfluenceSpaces", {
      limit: 100,
    });
    const found = spaces.results.find((s) => s.name === "gojira-e2e-space");
    expect(found).toBeDefined();

    const one = await h.call<{ id: string }>("confluence.getConfluenceSpace", { spaceId: found!.id });
    expect(one.id).toBe(found!.id);

    const up = await h.call<{ ok: boolean }>("confluence.updateConfluenceSpace", {
      spaceKey: KEY,
      name: "gojira-e2e-space-v2",
      commit: true,
    });
    expect(up.ok).toBe(true);

    const perms = await h.call<{ results: unknown[] }>("confluence.listSpacePermissions", { spaceId: found!.id });
    expect(perms.results.length).toBeGreaterThan(0);

    const del = await h.call<{ ok: boolean }>("confluence.deleteConfluenceSpace", { spaceKey: KEY, commit: true });
    expect(del.ok).toBe(true);
  });

  it("templates + blueprints read", async () => {
    await h.call("confluence.listTemplates", {});
    await h.call("confluence.listBlueprints", {});
  });
});
