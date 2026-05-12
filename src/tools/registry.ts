import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolDeps } from "./types.js";
import { registerWrappedTool } from "./wrapHandler.js";
import { allTools } from "./defs/index.js";
import type { AnyToolDef } from "./defs/defineTool.js";

export interface RegistrationFilter {
  /** Whether to register admin_org tools. */
  orgAdminEnabled: boolean;
  /**
   * Operator allowlist — only groups in this set register.
   * Sourced from `GOJIRA_ENABLED_GROUPS`.
   */
  enabledGroups: string[];
}

export function filterTools(defs: AnyToolDef[], filter: RegistrationFilter): AnyToolDef[] {
  const enabled = new Set(filter.enabledGroups);
  return defs.filter((d) => {
    if (!enabled.has(d.group)) return false;
    if (d.group === "admin_org" && !filter.orgAdminEnabled) return false;
    return true;
  });
}

export function registerSessionTools(
  server: McpServer,
  deps: ToolDeps,
  opts: { clientId: string },
): { registered: string[]; skipped: string[] } {
  const filter: RegistrationFilter = {
    orgAdminEnabled: deps.config.orgAdmin.enabled,
    enabledGroups: deps.config.enabledGroups,
  };
  const all = allTools();
  const filtered = filterTools(all, filter);
  const registered: string[] = [];
  for (const def of filtered) {
    registerWrappedTool(server, def, deps, opts);
    registered.push(def.name);
  }
  const allNames = new Set(all.map((d) => d.name));
  const skipped: string[] = [];
  for (const n of allNames) if (!registered.includes(n)) skipped.push(n);
  return { registered, skipped };
}
