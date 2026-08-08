import { describe, expect, it } from "vitest";
import { allTools } from "../../src/tools/defs/index.js";
import { reverters } from "../../src/operations/revert.js";
import { allLegacyAliases } from "../../src/operations/legacyAliases.js";

/**
 * Manifest-driven successor to the source-walking revertCoverage test: the
 * defineOpTool manifest is machine truth, so coverage is enforced at op
 * granularity — one registered reverter per op that claims revertibility, no
 * dead keys, admin_org spotless, and every legacy alias resolving to something
 * real. Vacuously green while no module is converted; bites harder with every
 * conversion stage.
 */
describe("op-level revert coverage (manifest-driven)", () => {
  const tools = allTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  const opTools = tools.filter((t) => t.ops && t.ops.length > 0);

  it("every op that claims revertibility has a reverter under tool#op", () => {
    const missing: string[] = [];
    for (const t of opTools) {
      for (const op of t.ops!) {
        if (op.claimsRevertible && !reverters.has(`${t.name}#${op.op}`)) {
          missing.push(`${t.name}#${op.op}`);
        }
      }
    }
    expect(missing, `Ops promise revert without a registered reverter: ${missing.join(", ")}`).toEqual([]);
  });

  it("every tool#op reverter key resolves to a live tool and a live op", () => {
    const dead: string[] = [];
    for (const key of reverters.names()) {
      if (!key.includes("#")) continue; // bare names covered by revertCoverage.test.ts
      const [tool, op] = key.split("#");
      const def = byName.get(tool);
      if (!def || !def.ops?.some((o) => o.op === op)) dead.push(key);
    }
    expect(dead, `Reverters keyed to nonexistent tool#op: ${dead.join(", ")}`).toEqual([]);
  });

  it("admin_org op tools register no reverters and claim no revertibility", () => {
    for (const t of opTools.filter((t) => t.group === "admin_org")) {
      for (const op of t.ops!) {
        expect(op.claimsRevertible, `${t.name}#${op.op}`).toBe(false);
        expect(reverters.has(`${t.name}#${op.op}`), `${t.name}#${op.op}`).toBe(false);
      }
    }
  });

  it("every legacy alias points at a live tool (and a live op when set)", () => {
    const broken: string[] = [];
    for (const [oldName, alias] of allLegacyAliases()) {
      const def = byName.get(alias.tool);
      if (!def) {
        broken.push(`${oldName} → missing tool ${alias.tool}`);
        continue;
      }
      if (alias.op !== null && !def.ops?.some((o) => o.op === alias.op)) {
        broken.push(`${oldName} → ${alias.tool}#${alias.op} (no such op)`);
      }
    }
    expect(broken, broken.join("; ")).toEqual([]);
  });

  it("no legacy alias shadows a live tool name", () => {
    // An old name that still exists in the catalog would make the alias
    // ambiguous — canonicalization must never rewrite a live tool.
    const shadows = [...allLegacyAliases().keys()].filter((oldName) => byName.has(oldName));
    expect(shadows, `Aliases shadow live tools: ${shadows.join(", ")}`).toEqual([]);
  });

  it("op tools are homogeneous and annotate honestly", () => {
    for (const t of opTools) {
      const destructiveOps = t.ops!.filter((o) => o.destructive).length;
      expect(
        destructiveOps === 0 || destructiveOps === t.ops!.length,
        `${t.name} mixes destructive and read ops`,
      ).toBe(true);
      if (destructiveOps === 0) {
        expect(t.readOnly, `${t.name}: all-read op tool must set readOnly`).toBe(true);
        expect(t.destructive).toBe(false);
      } else {
        expect(t.destructive, `${t.name}: destructive ops require destructive:true`).toBe(true);
      }
      expect(t.ops!.length).toBeGreaterThanOrEqual(2);
      expect(t.ops!.length).toBeLessThanOrEqual(7);
    }
  });
});
