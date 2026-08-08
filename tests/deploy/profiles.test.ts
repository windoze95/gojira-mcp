import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { allTools } from "../../src/tools/defs/index.js";
import { filterTools } from "../../src/tools/registry.js";
import { ALL_PERMISSION_GROUPS } from "../../src/tools/permissionGroups.js";

/**
 * Machine-verifies the shipped split-surface profile files
 * (deploy/profiles/*.env.example): every group name is real, every group is
 * reachable through some profile, and the tool counts advertised in the file
 * comments / README stay true as the catalog evolves.
 */

const PROFILES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../deploy/profiles");

/** Documented tool count per profile — update alongside README + env comments.
 * Mid-collapse values; final target 26/26/21/19/12 (plan: CRUD collapse). */
const EXPECTED_COUNTS: Record<string, number> = {
  readonly: 55,
  service: 65,
  platform: 29,
  workspace: 20,
  org: 24,
};

function parseEnvExample(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

const profileFiles = readdirSync(PROFILES_DIR)
  .filter((f) => f.endsWith(".env.example") && f !== "shared.env.example")
  .sort();

const profiles = profileFiles.map((f) => {
  const name = f.replace(".env.example", "");
  const env = parseEnvExample(join(PROFILES_DIR, f));
  const groups = (env.GOJIRA_ENABLED_GROUPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { name, env, groups };
});

describe("deploy/profiles/*.env.example", () => {
  it("ships exactly the documented profiles", () => {
    expect(profiles.map((p) => p.name)).toEqual(Object.keys(EXPECTED_COUNTS).sort());
  });

  it("uses only real permission groups", () => {
    const known = new Set<string>(ALL_PERMISSION_GROUPS);
    for (const p of profiles) {
      expect(p.groups.length, `${p.name}: GOJIRA_ENABLED_GROUPS missing`).toBeGreaterThan(0);
      const unknown = p.groups.filter((g) => !known.has(g));
      expect(unknown, `${p.name}: unknown groups`).toEqual([]);
    }
  });

  it("includes utility in every profile — nothing auto-injects it", () => {
    for (const p of profiles) {
      expect(p.groups, p.name).toContain("utility");
    }
  });

  it("names every instance, distinctly", () => {
    const names = profiles.map((p) => p.env.GOJIRA_INSTANCE_NAME);
    for (const [i, n] of names.entries()) {
      expect(n, `${profiles[i].name}: GOJIRA_INSTANCE_NAME missing`).toBeTruthy();
      expect(n).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it("registers the documented tool count per profile", () => {
    const all = allTools();
    for (const p of profiles) {
      const orgAdminEnabled = (p.env.GOJIRA_ENABLE_ORG_ADMIN ?? "false") === "true";
      const registered = filterTools(all, { orgAdminEnabled, enabledGroups: p.groups });
      expect(registered.length, `${p.name}: tool count drifted — update the profile comment + README`).toBe(
        EXPECTED_COUNTS[p.name],
      );
    }
  });

  it("covers every permission group except delete_projects (deliberately opt-in)", () => {
    const union = new Set(profiles.flatMap((p) => p.groups));
    const uncovered = ALL_PERMISSION_GROUPS.filter((g) => !union.has(g));
    expect(uncovered).toEqual(["delete_projects"]);
    // …and the opt-in path is documented as a commented alternate in platform.
    const platformRaw = readFileSync(join(PROFILES_DIR, "platform.env.example"), "utf8");
    expect(platformRaw).toMatch(/^# GOJIRA_ENABLED_GROUPS=.*delete_projects/m);
  });

  it("keeps org admin isolated to the org profile, fully configured", () => {
    for (const p of profiles) {
      const flagged = (p.env.GOJIRA_ENABLE_ORG_ADMIN ?? "false") === "true";
      expect(flagged, p.name).toBe(p.name === "org");
      expect(p.groups.includes("admin_org"), p.name).toBe(p.name === "org");
    }
    const org = profiles.find((p) => p.name === "org")!;
    for (const key of ["GOJIRA_ORG_ADMIN_TOKEN", "GOJIRA_ORG_ID", "GOJIRA_ORG_ADMIN_ACCOUNT_IDS"]) {
      expect(Object.keys(org.env), `org profile must carry ${key}`).toContain(key);
    }
    expect(org.env.GOJIRA_ORG_ADMIN_AUDIT_LOG_TARGET, "org profile keeps a separate audit stream").toBeTruthy();
  });

  it("profiles overlap only on utility (the fleet partitions the write surface)", () => {
    const nonUtility = profiles.map((p) => new Set(p.groups.filter((g) => g !== "utility")));
    for (let i = 0; i < nonUtility.length; i++) {
      for (let j = i + 1; j < nonUtility.length; j++) {
        const overlap = [...nonUtility[i]].filter((g) => nonUtility[j].has(g));
        // readonly deliberately shares the read_* groups with the write bundles;
        // write groups must never appear twice.
        const writeOverlap = overlap.filter((g) => !g.startsWith("read_"));
        expect(writeOverlap, `${profiles[i].name} ∩ ${profiles[j].name}`).toEqual([]);
      }
    }
  });
});
