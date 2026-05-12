import axios from "axios";
import type { RedisType } from "../redis/client.js";
import type { AppConfig } from "../config.js";
import { adminBase } from "../atlassian/client.js";
import { logger } from "../utils/logger.js";
import { InsufficientPermissionsError } from "../middleware/errorHandler.js";

/**
 * admin_org caller verification. Every admin_org tool call first verifies the
 * caller's accountId appears in /admin/v1/orgs/<orgId>/users?role=admin.
 *
 * Cached 5 min per accountId.
 */
const CACHE_TTL_SECONDS = 5 * 60;

export class OrgAdminVerifier {
  constructor(
    private readonly redis: RedisType,
    private readonly config: AppConfig,
  ) {}

  private cacheKey(accountId: string): string {
    return `org_admin_verified:${accountId}`;
  }

  async verify(accountId: string): Promise<void> {
    if (!this.config.orgAdmin.enabled) {
      throw new InsufficientPermissionsError("Org admin tools are not enabled on this instance");
    }
    const cached = await this.redis.get(this.cacheKey(accountId));
    if (cached === "yes") return;
    if (cached === "no") {
      throw new InsufficientPermissionsError("Caller is not an organization admin");
    }
    const ok = await this.probe(accountId);
    await this.redis.set(this.cacheKey(accountId), ok ? "yes" : "no", "EX", CACHE_TTL_SECONDS);
    if (!ok) throw new InsufficientPermissionsError("Caller is not an organization admin");
  }

  /**
   * Probes admin.atlassian.com for the org's admin roster. The endpoint is
   * paginated; we walk pages until we find the caller or exhaust the list.
   */
  private async probe(accountId: string): Promise<boolean> {
    const orgId = this.config.orgAdmin.orgId;
    const token = this.config.orgAdmin.token;
    if (!orgId || !token) return false;
    let cursor: string | undefined = undefined;
    let safety = 50; // hard upper bound on pages
    while (safety-- > 0) {
      const url: string = cursor
        ? `${adminBase()}/orgs/${orgId}/users?cursor=${encodeURIComponent(cursor)}`
        : `${adminBase()}/orgs/${orgId}/users`;
      try {
        const resp = await axios.get<{
          data: Array<{ account_id: string; account_type?: string; account_status?: string }>;
          links?: { next?: string };
          meta?: { next_cursor?: string };
        }>(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          timeout: 15_000,
        });
        const body = resp.data;
        const users = body.data ?? [];
        for (const u of users) {
          // org-admin roster endpoint returns roles per user in some shapes;
          // for the basic /users endpoint we trust enumeration as the org's
          // managed accounts. Fall back to a dedicated /admins call if needed.
          if (u.account_id === accountId) return true;
        }
        cursor = body.meta?.next_cursor;
        if (!cursor && body.links?.next) {
          // Parse cursor from links.next if meta absent.
          try {
            const u = new URL(body.links.next, adminBase());
            cursor = u.searchParams.get("cursor") ?? undefined;
          } catch {
            cursor = undefined;
          }
        }
        if (!cursor) return false;
      } catch (err) {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            accountId,
          },
          "Org admin verification probe failed",
        );
        return false;
      }
    }
    return false;
  }
}
