import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../../src/tools/defs/defineTool.js";
import { filterTools } from "../../src/tools/registry.js";

const readProjects = defineTool({
  name: "projects.listJiraProjects",
  description: "read_projects",
  group: "read_projects",
  authMethod: "oauth",
  needsCloudId: true,
  input: { x: z.string() },
  handler: async () => ({}),
});
const writeProjects = defineTool({
  name: "projects.createJiraProject",
  description: "write_projects",
  group: "write_projects",
  authMethod: "oauth",
  needsCloudId: true,
  input: { x: z.string() },
  handler: async () => ({}),
});
const deleteProjects = defineTool({
  name: "projects.deleteJiraProject",
  description: "delete_projects (isolated)",
  group: "delete_projects",
  authMethod: "oauth",
  needsCloudId: true,
  input: { x: z.string() },
  handler: async () => ({}),
});
const orgAdmin = defineTool({
  name: "orgAdmin.deactivateUser",
  description: "admin_org",
  group: "admin_org",
  authMethod: "org_admin",
  needsCloudId: false,
  input: { x: z.string() },
  handler: async () => ({}),
});
const utility = defineTool({
  name: "gojira.health",
  description: "utility",
  group: "utility",
  authMethod: "none",
  needsCloudId: false,
  handler: async () => ({}),
});

const all = [readProjects, writeProjects, deleteProjects, orgAdmin, utility];

const ALL_GROUPS = [
  "utility",
  "read_projects",
  "write_projects",
  "delete_projects",
  "admin_org",
];

describe("registry — operator allowlist + org-admin gate", () => {
  it("registers everything when every group is in the allowlist and org admin is enabled", () => {
    const filtered = filterTools(all, {
      orgAdminEnabled: true,
      enabledGroups: ALL_GROUPS,
    });
    expect(filtered.map((d) => d.name).sort()).toEqual([
      "gojira.health",
      "orgAdmin.deactivateUser",
      "projects.createJiraProject",
      "projects.deleteJiraProject",
      "projects.listJiraProjects",
    ]);
  });

  it("hides admin_org when org admin disabled even if allowlisted", () => {
    const filtered = filterTools(all, {
      orgAdminEnabled: false,
      enabledGroups: ALL_GROUPS,
    });
    expect(filtered.map((d) => d.name)).not.toContain("orgAdmin.deactivateUser");
  });

  it("omits groups not in the allowlist", () => {
    const filtered = filterTools(all, {
      orgAdminEnabled: true,
      enabledGroups: ["utility", "read_projects", "write_projects", "admin_org"],
    });
    expect(filtered.map((d) => d.name)).not.toContain("projects.deleteJiraProject");
    expect(filtered.map((d) => d.name)).toContain("projects.createJiraProject");
  });

  it("omits utility too when not allowlisted", () => {
    const filtered = filterTools([utility], {
      orgAdminEnabled: false,
      enabledGroups: ["read_projects"],
    });
    expect(filtered).toHaveLength(0);
  });
});
