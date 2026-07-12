import { describe, expect, it, beforeAll } from "vitest";
import { buildHarness, noCreds } from "./harness.js";
import type { E2EHarness } from "./harness.js";

/**
 * Assets / CMDB is a **Premium** JSM feature. The dev tenant used for the rest
 * of the e2e suite is JSM Free, where every Assets data-plane call 403s
 * ("Access to Assets API was denied"). This suite is therefore gated behind an
 * explicit E2E_ASSETS=1 and only runs when pointed at a Premium tenant whose
 * OAuth app carries the CMDB scopes. It is the ready-to-run verification for the
 * one tool group that couldn't be live-tested during the build.
 *
 * Env:
 *   E2E_OAUTH_ACCESS_TOKEN  — OAuth token WITH the CMDB scopes (required)
 *   E2E_ASSETS=1            — opt in to running this suite (required)
 *   E2E_ASSETS_OBJECT_TYPE_ID + E2E_ASSETS_NAME_ATTR_ID — a writable object type
 *     and the objectTypeAttributeId of its "Name" attribute; enables the
 *     create→get→update→delete object round-trip. Without both, only the read
 *     paths run. Everything created is deleted; the tenant is left clean.
 */
const enabled = !noCreds && !!process.env.E2E_OAUTH_ACCESS_TOKEN && process.env.E2E_ASSETS === "1";
const canWrite = !!process.env.E2E_ASSETS_OBJECT_TYPE_ID && !!process.env.E2E_ASSETS_NAME_ATTR_ID;

describe.skipIf(!enabled)("e2e: Assets / CMDB (Premium)", () => {
  let h: E2EHarness;
  let schemaId: string | undefined;

  beforeAll(async () => {
    h = buildHarness();
    const schemas = await h.call<{ values?: Array<{ id: string }> } | Array<{ id: string }>>(
      "assets.listObjectSchemas",
      {},
    );
    const list = Array.isArray(schemas) ? schemas : (schemas.values ?? []);
    schemaId = list[0]?.id;
  });

  it("lists schemas and reads object types (workspace discovery + read plane)", async () => {
    expect(schemaId, "the Premium tenant should have at least one object schema").toBeTruthy();
    const types = await h.call("assets.listObjectTypes", { schemaId });
    expect(types).toBeTruthy();
  });

  it("runs an AQL search without error", async () => {
    // Zero matches is still success — we're proving the endpoint + auth work.
    const res = await h.call("assets.aqlSearch", { qlQuery: "objectId > 0", resultPerPage: 1 });
    expect(res).toBeTruthy();
  });

  it.skipIf(!canWrite)("object create → get → update → delete round-trip (leaves tenant clean)", async () => {
    const objectTypeId = process.env.E2E_ASSETS_OBJECT_TYPE_ID!;
    const nameAttrId = process.env.E2E_ASSETS_NAME_ATTR_ID!;
    const attr = (name: string) => [
      { objectTypeAttributeId: nameAttrId, objectAttributeValues: [{ value: name }] },
    ];

    const created = await h.call<{ ok: boolean; object?: { id?: string } }>("assets.createObject", {
      objectTypeId,
      attributes: attr("gojira-e2e-probe"),
      commit: true,
    });
    const objectId = created.object?.id;
    try {
      expect(created.ok).toBe(true);
      expect(objectId).toBeTruthy();

      const got = await h.call<{ id: string }>("assets.getObject", { objectId });
      expect(got.id).toBe(objectId);

      const updated = await h.call<{ ok: boolean }>("assets.updateObject", {
        objectId,
        attributes: attr("gojira-e2e-probe-v2"),
        commit: true,
      });
      expect(updated.ok).toBe(true);
    } finally {
      if (objectId) await h.callRaw("assets.deleteObject", { objectId, commit: true });
    }
  });
});
