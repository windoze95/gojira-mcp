/**
 * Minimal RFC 6902 JSON Patch generator used for commit-positive consent
 * dry-runs. Produces add/replace/remove ops for differences between two
 * JSON-compatible values. Order of properties is normalized to be stable.
 */

export type JsonPatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: unknown };

export function generateJsonPatch(before: unknown, after: unknown): JsonPatchOp[] {
  const out: JsonPatchOp[] = [];
  diff(before, after, "", out);
  return out;
}

function diff(a: unknown, b: unknown, path: string, out: JsonPatchOp[]): void {
  if (deepEqual(a, b)) return;
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      const p = `${path}/${escapeSegment(k)}`;
      const inA = Object.prototype.hasOwnProperty.call(a, k);
      const inB = Object.prototype.hasOwnProperty.call(b, k);
      if (!inA && inB) {
        out.push({ op: "add", path: p, value: (b as Record<string, unknown>)[k] });
      } else if (inA && !inB) {
        out.push({ op: "remove", path: p });
      } else {
        diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], p, out);
      }
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    // Replace the whole array if it differs — array-level patches are notoriously
    // ambiguous without identity keys, so we choose simplicity over cleverness.
    if (!deepEqual(a, b)) {
      out.push({ op: "replace", path: path === "" ? "/" : path, value: b });
    }
    return;
  }
  // Primitive or type mismatch.
  out.push({ op: "replace", path: path === "" ? "/" : path, value: b });
}

function escapeSegment(s: string): string {
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object") {
    const ak = Object.keys(a as Record<string, unknown>);
    const bk = Object.keys(b as Record<string, unknown>);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}
