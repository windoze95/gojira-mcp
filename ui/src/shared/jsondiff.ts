/**
 * Client-side port of src/consent/jsonPatch.ts — same semantics (add /
 * remove / replace; arrays replaced wholesale) so journal before/after pairs
 * render with the exact diff the server would have produced at dry-run time.
 */
import type { JsonPatchOp } from "./envelope.js";

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
        out.push({ op: "add", path: p, value: b[k] });
      } else if (inA && !inB) {
        out.push({ op: "remove", path: p });
      } else {
        diff(a[k], b[k], p, out);
      }
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (!deepEqual(a, b)) {
      out.push({ op: "replace", path: path === "" ? "/" : path, value: b });
    }
    return;
  }
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
    return ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}
