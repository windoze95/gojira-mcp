import type { RedisType } from "../redis/client.js";
import type { AppConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { InsufficientPermissionsError } from "../middleware/errorHandler.js";

/**
 * admin_org caller verification.
 *
 * Security note: Atlassian's org API has no reliable public endpoint that
 * enumerates *only* organization administrators — `GET /admin/v1/orgs/<orgId>/users`
 * returns every managed account in the org. Verifying membership against that
 * list would let any licensed user pass the gate and act with the deployment's
 * global org-admin token (privilege escalation).
 *
 * Instead, the set of accounts permitted to invoke admin_org tools is declared
 * explicitly by the operator via `GOJIRA_ORG_ADMIN_ACCOUNT_IDS`. Only accountIds
 * on that allowlist pass. An empty allowlist (with org admin enabled) denies
 * everyone — fail closed. Startup config validation already requires the
 * allowlist to be non-empty when `GOJIRA_ENABLE_ORG_ADMIN=true`.
 */
export class OrgAdminVerifier {
  private readonly allow: ReadonlySet<string>;

  constructor(
    _redis: RedisType,
    private readonly config: AppConfig,
  ) {
    this.allow = new Set(config.orgAdmin.adminAccountIds);
  }

  async verify(accountId: string): Promise<void> {
    if (!this.config.orgAdmin.enabled) {
      throw new InsufficientPermissionsError("Org admin tools are not enabled on this instance");
    }
    if (!this.allow.has(accountId)) {
      logger.warn(
        { accountId, allowlistSize: this.allow.size },
        "Org-admin gate denied: caller not on GOJIRA_ORG_ADMIN_ACCOUNT_IDS allowlist",
      );
      throw new InsufficientPermissionsError(
        "Caller is not an authorized organization admin for this instance.",
        {
          hint: "Add the caller's Atlassian accountId to GOJIRA_ORG_ADMIN_ACCOUNT_IDS.",
        },
      );
    }
  }
}
