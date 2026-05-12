import { describe, expect, it, beforeEach } from "vitest";
import { OperationJournal } from "../../src/operations/journal.js";
import { makeRedis } from "../helpers/redis.js";

describe("OperationJournal (D2)", () => {
  let redis: ReturnType<typeof makeRedis>;
  let journal: OperationJournal;
  const accountId = "user-1";

  beforeEach(() => {
    redis = makeRedis();
    journal = new OperationJournal(redis, 30);
  });

  it("persists an operation entry under a per-user index", async () => {
    const opId = await journal.begin({
      accountId,
      tool: "createCustomField",
      cloudId: "cloud-1",
      target: { kind: "custom_field", name: "Color" },
      before: null,
      request: { name: "Color", type: "select" },
      revertible: true,
    });
    const entry = await journal.complete(opId, {
      accountId,
      tool: "createCustomField",
      cloudId: "cloud-1",
      target: { kind: "custom_field", name: "Color", id: "10101" },
      before: null,
      request: { name: "Color", type: "select" },
      revertible: true,
      after: { id: "10101", name: "Color" },
      outcome: "success",
    });
    expect(entry.opId).toBe(opId);
    expect(entry.outcome).toBe("success");
    expect(entry.revertible).toBe(true);

    const got = await journal.get(accountId, opId);
    expect(got?.target.id).toBe("10101");
  });

  it("returns recent ops in reverse-chronological order", async () => {
    for (let i = 0; i < 5; i++) {
      const opId = await journal.begin({
        accountId,
        tool: "noop",
        cloudId: null,
        target: { kind: "noop", id: String(i) },
        before: null,
        request: {},
        revertible: false,
      });
      await journal.complete(opId, {
        accountId,
        tool: "noop",
        cloudId: null,
        target: { kind: "noop", id: String(i) },
        before: null,
        request: {},
        revertible: false,
        after: null,
        outcome: "success",
      });
      // Force a sortable difference.
      await new Promise((r) => setTimeout(r, 5));
    }
    const list = await journal.list(accountId, { limit: 3 });
    expect(list).toHaveLength(3);
    // Newest first
    const ids = list.map((e) => Number((e.target as { id?: string }).id));
    expect(ids[0]).toBeGreaterThan(ids[2]);
  });

  it("marks failed ops as non-revertible regardless of input", async () => {
    const opId = await journal.begin({
      accountId,
      tool: "createCustomField",
      cloudId: null,
      target: { kind: "custom_field", name: "Foo" },
      before: null,
      request: {},
      revertible: true,
    });
    const entry = await journal.complete(opId, {
      accountId,
      tool: "createCustomField",
      cloudId: null,
      target: { kind: "custom_field", name: "Foo" },
      before: null,
      request: {},
      revertible: true,
      after: null,
      outcome: "failure",
      error: { code: "VALIDATION_ERROR", message: "bad" },
    });
    expect(entry.outcome).toBe("failure");
    expect(entry.revertible).toBe(false);
    expect(entry.errorCode).toBe("VALIDATION_ERROR");
  });
});
