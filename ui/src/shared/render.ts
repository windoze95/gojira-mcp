/** Renderers shared by the confirm-op card and the journal timeline. */
import { h, chip, codeInline, collapse, jsonBlock, valueCell } from "./dom.js";
import type { DryRunPayload, JsonPatchOp, ToolEnvelope } from "./envelope.js";

export function renderTarget(target: DryRunPayload["target"]): HTMLElement | null {
  if (!target) return null;
  const dl = h("dl", { class: "kv" });
  dl.append(h("dt", null, "Target"));
  const dd = h("dd", null);
  if (target.kind) dd.append(chip(String(target.kind)), " ");
  const label = target.name ?? target.key ?? target.id;
  if (label !== undefined) dd.append(h("strong", null, String(label)));
  const extras: string[] = [];
  if (target.name && target.key) extras.push(String(target.key));
  if (target.id && String(target.id) !== String(label)) extras.push(String(target.id));
  if (extras.length) dd.append(" ", h("span", { class: "hint" }, `(${extras.join(" · ")})`));
  dl.append(dd);
  return dl;
}

const OP_CHIP: Record<JsonPatchOp["op"], { text: string; variant: "success" | "danger" | "warning" }> = {
  add: { text: "add", variant: "success" },
  remove: { text: "remove", variant: "danger" },
  replace: { text: "replace", variant: "warning" },
};

export function renderPatchTable(patch: JsonPatchOp[]): HTMLElement {
  const tbody = h("tbody", null);
  for (const op of patch) {
    const meta = OP_CHIP[op.op] ?? { text: op.op, variant: "warning" as const };
    tbody.append(
      h(
        "tr",
        { class: `op-${op.op}` },
        h("td", null, chip(meta.text, meta.variant)),
        h("td", { class: "path" }, h("code", null, op.path)),
        h("td", { class: "val" }, op.op === "remove" ? h("span", { class: "hint" }, "—") : valueCell(op.value)),
      ),
    );
  }
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "grid" },
      h("thead", null, h("tr", null, h("th", null, "Op"), h("th", null, "Path"), h("th", null, "Value"))),
      tbody,
    ),
  );
}

export function renderBeforeAfter(before: unknown, after: unknown): HTMLElement {
  const wrap = h("div", { class: "stack" });
  if (before !== undefined) {
    wrap.append(collapse(h("span", null, "Current state"), jsonBlock(before), false));
  }
  if (after === null) {
    wrap.append(h("div", null, chip("will be deleted", "danger")));
  } else if (after !== undefined) {
    wrap.append(collapse(h("span", null, "After commit"), jsonBlock(after), false));
  }
  return wrap;
}

/** The diff section of a dry-run: patch table when present, panes otherwise. */
export function renderDiff(diff: DryRunPayload["diff"]): HTMLElement {
  const wrap = h("div", { class: "stack" });
  if (diff?.patch?.length) {
    wrap.append(renderPatchTable(diff.patch));
    if (diff.before !== undefined || diff.after !== undefined) {
      wrap.append(renderBeforeAfter(diff.before, diff.after));
    }
    return wrap;
  }
  if (diff && (diff.before !== undefined || diff.after !== undefined)) {
    wrap.append(renderBeforeAfter(diff.before, diff.after));
    return wrap;
  }
  wrap.append(h("div", { class: "hint" }, "No field-level changes detected."));
  return wrap;
}

export function renderErrorCard(envelope: ToolEnvelope | null): HTMLElement {
  const err = envelope?.error;
  const card = h("div", { class: "stack" });
  const banner = h("div", { class: "banner danger" });
  if (err?.code) banner.append(chip(err.code, "danger"), " ");
  banner.append(h("strong", null, "Tool call failed"), err?.message ? ` — ${err.message}` : "");
  card.append(banner);
  if (err?.details !== undefined) {
    card.append(collapse(h("span", null, "Details"), jsonBlock(err.details)));
  }
  if (err?.reference_id) {
    card.append(h("div", { class: "hint" }, "Reference: ", codeInline(err.reference_id)));
  }
  return card;
}

const RESULT_KV_KEYS: Array<[key: string, label: string]> = [
  ["journal_id", "Journal id"],
  ["original_op_id", "Reverted op"],
  ["deleted", "Deleted"],
  ["restored", "Restored"],
];

/** A committed (non-dry-run) success payload. */
export function renderResultCard(result: unknown): HTMLElement {
  const card = h("div", { class: "stack" });
  const r = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;
  const reverted = r.reverted === true;
  card.append(
    h(
      "div",
      { class: "banner success" },
      h("strong", null, reverted ? "Reverted" : "Change applied"),
      " — the operation was committed.",
    ),
  );
  const kv = h("dl", { class: "kv" });
  let any = false;
  for (const [key, label] of RESULT_KV_KEYS) {
    if (r[key] !== undefined) {
      kv.append(h("dt", null, label), h("dd", null, codeInline(String(r[key]))));
      any = true;
    }
  }
  if (any) card.append(kv);
  card.append(collapse(h("span", null, "Raw result"), jsonBlock(result)));
  return card;
}

export function renderLoading(text: string): HTMLElement {
  return h("div", { class: "state" }, h("span", { class: "spinner" }), text);
}
