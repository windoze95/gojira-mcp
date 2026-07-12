import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { allTools } from "../../src/tools/defs/index.js";
import { reverters } from "../../src/operations/revert.js";

/**
 * Structural guard for the revert system.
 *
 * A tool that journals `revertible: true` promises the operator an undo, but the
 * promise is only real if a reverter is registered for that exact tool name —
 * otherwise `assertRevertible` throws "No reverter registered" and
 * gojira.revertOperation refuses every attempt. A full-repo review found 22
 * tools making that empty promise; these tests keep it from happening again.
 *
 * Importing allTools() also loads every def module, whose top-level
 * `reverters.register(...)` calls populate the registry.
 */
const DEFS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../src/tools/defs");

/**
 * Every journalOp call passes a `tool:` name and a `revertible:` value. Walk each
 * `revertible:` occurrence back to its nearest preceding `tool:` to pair them.
 * Values that are not the literal `false` (i.e. `true`, or a variable like
 * `enableUndo` that can be true at runtime) require a reverter.
 *
 * A few tools are generated in a loop and name themselves with a template
 * literal (e.g. automation enable/disable). Those can't be resolved statically,
 * so they're skipped here rather than mis-attributed to the previous static
 * name — the "no reverter for a nonexistent tool" test below is what catches a
 * mistake in their loop-registered reverters.
 */
function claimedRevertibleTools(): Array<{ tool: string; value: string; file: string }> {
  const claims: Array<{ tool: string; value: string; file: string }> = [];
  for (const file of readdirSync(DEFS_DIR).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(DEFS_DIR, file), "utf8");
    const revertibleRe = /revertible:\s*([A-Za-z_][\w.]*)/g;
    let m: RegExpExecArray | null;
    while ((m = revertibleRe.exec(src))) {
      if (m[1] === "false") continue;
      // Nearest preceding tool name, in either quoted or template-literal form.
      const before = src.slice(0, m.index);
      const toolMatches = [...before.matchAll(/tool:\s*(?:"([^"]+)"|`([^`]+)`)/g)];
      const nearest = toolMatches[toolMatches.length - 1];
      if (!nearest) continue;
      const [, quoted, templated] = nearest;
      if (templated !== undefined) continue; // dynamically named — see note above
      claims.push({ tool: quoted, value: m[1], file });
    }
  }
  return claims;
}

describe("revert coverage", () => {
  it("every tool that journals revertible has a registered reverter", () => {
    const claims = claimedRevertibleTools();
    expect(claims.length).toBeGreaterThan(0); // the scan itself must be working

    const unbacked = claims
      .filter((c) => !reverters.has(c.tool))
      .map((c) => `${c.file}: ${c.tool} (revertible: ${c.value}) has no reverter`);

    expect(unbacked, `Tools promise revert but revertOperation would refuse them:\n${unbacked.join("\n")}`).toEqual(
      [],
    );
  });

  it("every registered reverter names a tool that actually exists", () => {
    // A reverter keyed by a typo'd or removed tool name would silently never
    // fire, and the tool it was meant to protect would be unrevertable.
    const toolNames = new Set(allTools().map((t) => t.name));
    const registered = reverters.names();
    expect(registered.length).toBeGreaterThan(0);

    const dead = registered.filter((name) => !toolNames.has(name));
    expect(dead, `Reverters registered for nonexistent tools: ${dead.join(", ")}`).toEqual([]);
  });

  it("org-admin tools are deliberately not auto-revertible (revertOperation is not org-admin gated)", () => {
    // gojira.revertOperation lives in the `utility` group, so any caller can
    // invoke it. Registering reverters for admin_org tools would let a
    // non-org-admin undo an org admin's action without passing the gate.
    const orgAdminTools = allTools().filter((t) => t.group === "admin_org");
    expect(orgAdminTools.length).toBeGreaterThan(0);
    const revertable = orgAdminTools.filter((t) => reverters.has(t.name)).map((t) => t.name);
    expect(revertable, `admin_org tools must not have reverters: ${revertable.join(", ")}`).toEqual([]);
  });
});
