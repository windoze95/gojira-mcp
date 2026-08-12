/** Read-only review card for jsm.inspectRequestBuild. */
import { chip, clear, collapse, h, jsonBlock } from "./shared/dom.js";
import type { ParsedResult } from "./shared/envelope.js";
import { initView } from "./shared/host.js";
import { renderErrorCard, renderLoading } from "./shared/render.js";

type RecordValue = Record<string, unknown>;

const root = document.getElementById("app")!;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mount(...nodes: HTMLElement[]): void {
  clear(root);
  root.append(...nodes);
  root.removeAttribute("aria-busy");
}

function statusVariant(state: string): "danger" | "warning" | "success" | "info" {
  if (state === "incomplete") return "danger";
  if (state === "staged" || state === "needs_review") return "warning";
  if (state === "configured_unverified") return "success";
  return "info";
}

function pieceState(piece: unknown): { text: string; variant: "danger" | "warning" | "success" | "info" } {
  if (piece === null || piece === undefined) return { text: "not inspected", variant: "warning" };
  if (!isRecord(piece)) return { text: "available", variant: "success" };
  if (piece.ok === false) return { text: "read failed", variant: "danger" };
  if (piece.data === null && piece.rules === undefined) return { text: "not attached", variant: "warning" };
  if (piece.association === "candidate") return { text: "candidate", variant: "warning" };
  return { text: "available", variant: "success" };
}

function link(label: string, url: unknown): HTMLElement | null {
  if (typeof url !== "string" || !/^https:\/\//.test(url)) return null;
  return h("a", { href: url, target: "_blank", rel: "noreferrer" }, label);
}

function renderLinks(raw: unknown): HTMLElement | null {
  if (!isRecord(raw)) return null;
  const list = h("div", { class: "stack" });
  const known: Array<[string, string]> = [
    ["Portal request", "portalRequest"],
    ["Request types", "requestTypesSettings"],
    ["Forms", "formsSettings"],
    ["Form designer", "formDesigner"],
    ["Automation", "automationSettings"],
    ["Tracking work item", "trackingWorkItem"],
  ];
  for (const [label, key] of known) {
    const anchor = link(label, raw[key]);
    if (anchor) list.append(anchor);
  }
  const rules = isRecord(raw.automationRules) ? raw.automationRules : {};
  for (const [id, url] of Object.entries(rules)) {
    const anchor = link(`Automation rule ${id}`, url);
    if (anchor) list.append(anchor);
  }
  return list.childElementCount ? list : null;
}

function renderInspection(parsed: ParsedResult): void {
  if (parsed.isError) {
    mount(renderErrorCard(parsed.envelope));
    return;
  }
  if (!isRecord(parsed.result)) {
    mount(h("div", { class: "state" }, "Unrecognized request-build response."));
    return;
  }
  const result = parsed.result;
  const identity = isRecord(result.identity) ? result.identity : {};
  const readiness = isRecord(result.readiness) ? result.readiness : {};
  const state = typeof readiness.state === "string" ? readiness.state : "unknown";
  const wrap = h("div", { class: "stack" });
  wrap.append(
    h(
      "div",
      { class: "h-title" },
      typeof identity.requestTypeName === "string" ? identity.requestTypeName : "JSM request build",
      chip(state.replaceAll("_", " "), statusVariant(state)),
    ),
  );
  wrap.append(
    h(
      "div",
      { class: "h-sub" },
      `${String(identity.spaceKey ?? identity.spaceIdOrKey ?? "space")} · request type ${String(identity.requestTypeId ?? "—")}`,
    ),
  );

  const blockers = Array.isArray(readiness.blockers) ? readiness.blockers : [];
  const warnings = Array.isArray(readiness.warnings) ? readiness.warnings : [];
  if (blockers.length) {
    wrap.append(h("div", { class: "banner danger" }, blockers.map(String).join(" ")));
  }
  if (warnings.length) {
    wrap.append(h("div", { class: "banner warning" }, warnings.map(String).join(" ")));
  }

  const pieces = isRecord(result.pieces) ? result.pieces : {};
  const rows: Array<[string, unknown]> = [
    ["Request type", pieces.requestType],
    ["Fields", pieces.fields],
    ["Request-type groups", pieces.requestTypeGroups],
    ["Form", pieces.form],
    ["Work type", pieces.workType],
    ["Workflow scheme", pieces.workflowScheme],
    ["Automation", pieces.automation],
    ["Tracking work item", pieces.trackingWorkItem],
  ];
  const tbody = h("tbody", null);
  for (const [name, value] of rows) {
    const status = pieceState(value);
    tbody.append(
      h(
        "tr",
        null,
        h("td", null, name),
        h("td", null, chip(status.text, status.variant)),
        h("td", null, collapse(h("span", null, "Details"), jsonBlock(value))),
      ),
    );
  }
  wrap.append(
    h(
      "div",
      { class: "table-wrap" },
      h("table", { class: "grid" }, h("thead", null, h("tr", null, h("th", null, "Piece"), h("th", null, "State"), h("th", null, "Inspect"))), tbody),
    ),
  );

  const links = renderLinks(result.links);
  if (links) wrap.append(h("div", { class: "h-title" }, "Review links"), links);
  wrap.append(
    h("div", { class: "banner" }, "Live verification is intentionally separate: this inspector reports configuration, not a successful portal submission."),
  );
  mount(wrap);
}

mount(renderLoading("Waiting for request-build data…"));
void initView("gojira-request-build", {
  onResult: renderInspection,
  onCancelled: (reason) =>
    mount(h("div", { class: "state" }, `Tool call cancelled${reason ? ` — ${reason}` : ""}.`)),
});
