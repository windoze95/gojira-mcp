import type { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AtlassianClient } from "../atlassian/client.js";
import type { OperationJournal, JournalEntry, NewOperationArgs } from "../operations/journal.js";
import type { RateLimiter } from "../middleware/rateLimiter.js";
import type { StoredToken } from "../auth/tokenStore.js";
import type { StoredApiToken } from "../auth/apiTokenStore.js";
import type { AppConfig } from "../config.js";
import type { AuditSink } from "../utils/audit.js";
import type { Logger } from "../utils/logger.js";

import type { PermissionGroup } from "./permissionGroups.js";

/**
 * Auth method for a tool.
 * - "oauth": requires a fresh per-user OAuth token.
 * - "api_token": requires a bound per-user API token (OAuth loaded when present).
 * - "oauth_or_api_token": loads whichever of the two the caller has, requires
 *   neither up front — the client factory the handler actually uses throws if
 *   its credential is missing. For tools like revertOperation that dispatch to
 *   reverters with heterogeneous auth needs.
 * - "org_admin": uses the instance-wide org-admin key (separately gated).
 * - "none": no Atlassian credential.
 */
export type AuthMethod = "oauth" | "api_token" | "oauth_or_api_token" | "org_admin" | "none";

export type { PermissionGroup };

export interface ToolContext {
  /** Stable identity for this call. */
  accountId: string;
  /** Display info; convenient for audit + dry-run messages. */
  user: { accountId: string; name: string | null; email: string | null };
  /** Resolved cloudId after pinning enforcement. May be null for utility tools. */
  cloudId: string | null;
  /** Live upstream OAuth credential, if available. */
  storedToken: StoredToken | null;
  /** Per-user API token side-channel, if bound. */
  apiToken: StoredApiToken | null;
  /** Convenient client factories — see the implementation in registry.ts. */
  client: AtlassianClientFactories;
  journal: OperationJournal;
  audit: AuditSink;
  config: AppConfig;
  log: Logger;
  rateLimiter: RateLimiter;
  /** Direct Redis access for tools that need to read/write the shared store. */
  redis: import("../redis/client.js").RedisType;
  /** Convenience that captures `{tool, accountId, cloudId}` for journal calls. */
  defaultJournalArgs: Pick<NewOperationArgs, "accountId" | "tool" | "cloudId">;
  /**
   * Journals an operation. Returns the journaled entry (success or failure).
   * Callers should invoke this around their mutation.
   *
   * `deriveTargetId` lets a create tool extract the newly-created id from the
   * run() result so it is persisted onto the journal target BEFORE completion —
   * this is what makes revert work (reverters read `entry.target.id`). Mutating
   * the returned entry afterward does NOT persist.
   */
  journalOp(
    args: NewOperationArgs & {
      run: () => Promise<unknown>;
      revertible?: boolean;
      deriveTargetId?: (after: unknown) => string | undefined;
    },
  ): Promise<JournalEntry>;
}

export interface AtlassianClientFactories {
  /** OAuth-authed Jira tenant base for the resolved cloudId. */
  jira(): AtlassianClient;
  /** OAuth-authed Confluence tenant base for the resolved cloudId. */
  confluence(): AtlassianClient;
  /** API-token-authed direct REST against the site URL. */
  apiTokenJira(): AtlassianClient;
  /** Org-admin-token-authed admin.atlassian.com base. */
  admin(): AtlassianClient;
  /** Assets API at a particular workspace. */
  assets(workspaceId: string): AtlassianClient;
  /** Jira Cloud Automation public API (api.atlassian.com/automation/public/jira/{cloudId}/rest/v1). */
  automation(): AtlassianClient;
}

export interface ToolDefinition<I extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> {
  name: string;
  description: string;
  group: PermissionGroup;
  authMethod: AuthMethod;
  /** Marks a destructive write — engages commit-positive consent. */
  destructive: boolean;
  /** Required cloudId binding; false for tools that don't address a Jira/Confluence tenant. */
  needsCloudId: boolean;
  /** Zod schema for input. */
  inputSchema: I;
  handler: (input: z.infer<I>, ctx: ToolContext) => Promise<O>;
}

export type RegisterTool = <I extends z.ZodTypeAny, O>(def: ToolDefinition<I, O>) => void;

/** Bundle of singletons every tool needs. */
export interface ToolDeps {
  config: AppConfig;
  redis: import("../redis/client.js").RedisType;
  rateLimiter: RateLimiter;
  audit: AuditSink;
  journal: OperationJournal;
  tokenRefresher: import("../auth/tokenRefresh.js").TokenRefresher;
  apiTokenStore: import("../auth/apiTokenStore.js").ApiTokenStore;
  orgAdminVerifier: import("../auth/orgAdminVerifier.js").OrgAdminVerifier;
}

export type RegisterAllTools = (server: McpServer, deps: ToolDeps, opts: {
  clientId: string;
}) => void;
