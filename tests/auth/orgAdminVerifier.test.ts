import { describe, expect, it } from "vitest";
import { OrgAdminVerifier } from "../../src/auth/orgAdminVerifier.js";
import { makeRedis } from "../helpers/redis.js";
import type { AppConfig } from "../../src/config.js";

function config(enabled: boolean, adminAccountIds: string[]): AppConfig {
  return {
    orgAdmin: { enabled, token: "t", orgId: "o", adminAccountIds },
  } as unknown as AppConfig;
}

describe("OrgAdminVerifier — operator-declared allowlist (no enumeration)", () => {
  it("allows an accountId on the allowlist", async () => {
    const v = new OrgAdminVerifier(makeRedis(), config(true, ["admin-1", "admin-2"]));
    await expect(v.verify("admin-2")).resolves.toBeUndefined();
  });

  it("denies an accountId that is NOT on the allowlist (the privilege-escalation fix)", async () => {
    const v = new OrgAdminVerifier(makeRedis(), config(true, ["admin-1"]));
    await expect(v.verify("random-employee")).rejects.toThrow(/not an authorized organization admin/i);
  });

  it("fails closed when the allowlist is empty", async () => {
    const v = new OrgAdminVerifier(makeRedis(), config(true, []));
    await expect(v.verify("anyone")).rejects.toThrow();
  });

  it("throws when org admin is disabled on the instance", async () => {
    const v = new OrgAdminVerifier(makeRedis(), config(false, ["admin-1"]));
    await expect(v.verify("admin-1")).rejects.toThrow(/not enabled/i);
  });
});
