import { describe, expect, it, beforeAll } from "vitest";
import { buildHarness, noCreds } from "./harness.js";
import type { E2EHarness } from "./harness.js";

describe.skipIf(noCreds)("e2e: JSM admin", () => {
  let h: E2EHarness;
  let serviceDeskId: string;
  beforeAll(() => {
    h = buildHarness();
  });

  it("lists service desks and reads one", async () => {
    const desks = await h.call<{ values: Array<{ id: string }> }>("jsm.listServiceDesks", {});
    expect(desks.values.length).toBeGreaterThan(0);
    serviceDeskId = desks.values[0].id;
    const one = await h.call<{ id: string }>("jsm.getServiceDesk", { serviceDeskId });
    expect(one.id).toBe(serviceDeskId);
  });

  it("reads request types, queues, organizations, KB", async () => {
    const rts = await h.call<{ values: unknown[] }>("jsm.listRequestTypes", { serviceDeskId });
    expect(rts.values.length).toBeGreaterThan(0);
    const queues = await h.call<{ values: Array<{ id: string }> }>("jsm.listQueues", { serviceDeskId });
    expect(Array.isArray(queues.values)).toBe(true);
    await h.call("jsm.listJsmOrganizations", {});
    await h.call("jsm.searchKnowledgeBaseArticles", { serviceDeskId, query: "vpn" });
  });

  it("request type create → dry-run gate → delete round-trip", async () => {
    // find an issue type to hang the request type on
    const rts = await h.call<{ values: Array<{ issueTypeId: string }> }>("jsm.listRequestTypes", { serviceDeskId });
    const issueTypeId = rts.values[0].issueTypeId;

    // dry-run first: no commit → no mutation
    const dry = await h.call<{ dry_run?: boolean }>("jsm.createRequestType", {
      serviceDeskId,
      issueTypeId,
      name: "gojira-e2e-rt",
      description: "e2e probe — safe to delete",
    });
    expect(dry.dry_run).toBe(true);

    const created = await h.call<{ ok: boolean; journal_id: string; requestType?: { id?: string } }>(
      "jsm.createRequestType",
      {
        serviceDeskId,
        issueTypeId,
        name: "gojira-e2e-rt",
        description: "e2e probe — safe to delete",
        commit: true,
      },
    );
    expect(created.ok).toBe(true);

    // find it and delete it
    const after = await h.call<{ values: Array<{ id: string; name: string }> }>("jsm.listRequestTypes", {
      serviceDeskId,
    });
    const probe = after.values.find((v) => v.name === "gojira-e2e-rt");
    expect(probe).toBeDefined();
    const del = await h.call<{ ok: boolean }>("jsm.deleteRequestType", {
      serviceDeskId,
      requestTypeId: probe!.id,
      commit: true,
    });
    expect(del.ok).toBe(true);
  });
});
