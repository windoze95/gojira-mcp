import { describe, expect, it } from "vitest";
import {
  buildDeleteDryRun,
  buildDryRunIfNotCommitted,
} from "../../src/consent/dryRun.js";
import { generateJsonPatch } from "../../src/consent/jsonPatch.js";

describe("commit-positive consent (D5)", () => {
  it("returns a dry-run when commit is omitted or false", () => {
    const out = buildDryRunIfNotCommitted({}, {
      tool: "x",
      target: { kind: "custom_field", name: "n" },
      before: null,
      after: { name: "n" },
    });
    expect(out).not.toBeNull();
    expect(out?.dry_run).toBe(true);
    expect(out?.diff.patch).toBeDefined();
  });

  it("returns null when commit:true (caller proceeds with mutation)", () => {
    const out = buildDryRunIfNotCommitted({ commit: true }, {
      tool: "x",
      target: { kind: "custom_field" },
      before: null,
      after: {},
    });
    expect(out).toBeNull();
  });

  it("buildDeleteDryRun emits a delete-flavored payload regardless of commit", () => {
    const out = buildDeleteDryRun({
      tool: "deleteX",
      target: { kind: "x", id: "1" },
      before: { id: "1", name: "n" },
    });
    expect(out.dry_run).toBe(true);
    expect(out.diff.before).toEqual({ id: "1", name: "n" });
    expect(out.diff.after).toBeNull();
  });
});

describe("RFC 6902 JSON Patch generator", () => {
  it("emits add/remove/replace for object diffs", () => {
    const patch = generateJsonPatch({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 });
    const ops = patch.map((p) => p.op).sort();
    expect(ops).toContain("replace");
    expect(ops).toContain("add");
  });

  it("escapes JSON Pointer segments containing / and ~", () => {
    const patch = generateJsonPatch({}, { "a/b~c": 1 });
    expect(patch[0].path).toBe("/a~1b~0c");
  });

  it("replaces whole arrays when they differ", () => {
    const patch = generateJsonPatch({ xs: [1, 2, 3] }, { xs: [1, 2, 4] });
    expect(patch).toEqual([{ op: "replace", path: "/xs", value: [1, 2, 4] }]);
  });

  it("emits no ops for equal values", () => {
    expect(generateJsonPatch({ a: 1 }, { a: 1 })).toEqual([]);
  });
});
