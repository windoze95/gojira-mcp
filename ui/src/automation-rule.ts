/**
 * Automation rule inspector — attached to automation.listAutomationRules
 * (summaries, cursor-paged) and automation.getAutomationRule (full rule).
 * A rule is a trigger → conditions/branches → actions tree; the JSON shapes
 * of component values are undocumented, so nodes render kind + type with the
 * raw value behind an expander rather than pretending to a schema.
 */
import { h, chip, clear, codeInline, collapse, jsonBlock, fmtCompact } from "./shared/dom.js";
import type { ParsedResult } from "./shared/envelope.js";
import { callTool, initView, type App } from "./shared/host.js";
import { renderErrorCard, renderLoading } from "./shared/render.js";

interface RuleComponent {
  component?: string;
  type?: string;
  value?: unknown;
  children?: unknown[];
  conditions?: unknown[];
}

interface RuleDoc extends RuleComponent {
  id?: unknown;
  name?: string;
  state?: string;
  description?: string;
  trigger?: RuleComponent;
  components?: unknown[];
  ruleScope?: unknown;
  labels?: unknown[];
}

const root = document.getElementById("app")!;
let app: App | null = null;
let lastArgs: Record<string, unknown> | null = null;
let listRows: Array<Record<string, unknown>> = [];
let listCursor: string | null = null;
let loadingMore = false;

function mount(...nodes: Array<HTMLElement | null>): void {
  clear(root);
  for (const n of nodes) if (n) root.append(n);
  root.removeAttribute("aria-busy");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function looksLikeRule(v: unknown): v is RuleDoc {
  return isRecord(v) && (isRecord(v.trigger) || Array.isArray(v.components));
}

/** `links.next` is a URL whose cursor query param continues the page. */
function extractCursor(result: Record<string, unknown>): string | null {
  if (typeof result.cursor === "string") return result.cursor;
  const links = result.links;
  const next = isRecord(links) && typeof links.next === "string" ? links.next : null;
  if (!next) return null;
  const m = /[?&]cursor=([^&]+)/.exec(next);
  return m ? decodeURIComponent(m[1]) : null;
}

function renderParsed(parsed: ParsedResult): void {
  if (parsed.isError) {
    mount(renderErrorCard(parsed.envelope));
    return;
  }
  const r = parsed.result;
  if (looksLikeRule(r)) {
    renderRule(r, null);
    return;
  }
  if (isRecord(r)) {
    // Rule wrapped one level down (some endpoints envelope as {rule: {...}}).
    if (looksLikeRule(r.rule)) {
      renderRule(r.rule, null);
      return;
    }
    const values = Array.isArray(r.values) ? r.values : Array.isArray(r.data) ? r.data : null;
    if (values) {
      listRows = values.filter(isRecord);
      listCursor = extractCursor(r);
      renderList();
      return;
    }
  }
  mount(h("div", { class: "state" }, "Unrecognized automation response shape."), collapse(h("span", null, "Raw result"), jsonBlock(r)));
}

function stateChip(state: unknown): HTMLElement | null {
  if (typeof state !== "string") return null;
  return chip(state, state === "ENABLED" ? "success" : undefined);
}

function ruleIdOf(row: Record<string, unknown>): string | null {
  const id = row.id ?? row.uuid ?? row.ruleUuid;
  return id === undefined || id === null ? null : String(id);
}

function renderList(): void {
  const wrap = h("div", { class: "stack" });
  wrap.append(h("div", { class: "h-title" }, "Automation rules", chip(String(listRows.length))));

  if (!listRows.length) {
    wrap.append(h("div", { class: "state" }, "No rules found."));
    mount(wrap);
    return;
  }

  const tbody = h("tbody", null);
  for (const row of listRows) {
    const id = ruleIdOf(row);
    const tr = h(
      "tr",
      { class: id && app ? "clickable" : undefined, title: id && app ? "Inspect rule" : undefined },
      h("td", null, typeof row.name === "string" ? row.name : "—"),
      h("td", null, stateChip(row.state)),
      h("td", null, id ? codeInline(id) : "—"),
    );
    if (id && app) tr.addEventListener("click", () => void openRule(id));
    tbody.append(tr);
  }
  wrap.append(
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "grid" },
        h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, "State"), h("th", null, "Id"))),
        tbody,
      ),
    ),
  );

  if (listCursor && app) {
    const more = h("button", { class: "btn ghost", type: "button", disabled: loadingMore || null }, "Load more");
    more.addEventListener("click", () => void loadMore(more));
    wrap.append(h("div", { class: "actions" }, more));
  }
  mount(wrap);
}

async function loadMore(btn: HTMLButtonElement): Promise<void> {
  if (!app || !listCursor || loadingMore) return;
  loadingMore = true;
  btn.disabled = true;
  try {
    const args: Record<string, unknown> = { ...(lastArgs ?? {}), cursor: listCursor };
    const parsed = await callTool(app, "automation.listAutomationRules", args);
    if (!parsed.isError && isRecord(parsed.result)) {
      const values = Array.isArray(parsed.result.values) ? parsed.result.values : [];
      listRows = [...listRows, ...values.filter(isRecord)];
      listCursor = extractCursor(parsed.result);
    }
  } finally {
    loadingMore = false;
    renderList();
  }
}

async function openRule(ruleId: string): Promise<void> {
  if (!app) return;
  mount(renderLoading(`Loading rule ${ruleId}…`));
  try {
    const parsed = await callTool(app, "automation.getAutomationRule", { ruleId });
    if (parsed.isError) {
      mount(backButton(), renderErrorCard(parsed.envelope));
      return;
    }
    const r = parsed.result;
    const rule = looksLikeRule(r) ? r : isRecord(r) && looksLikeRule(r.rule) ? r.rule : null;
    if (!rule) {
      mount(backButton(), h("div", { class: "state" }, "Rule payload not recognized."), jsonBlock(r));
      return;
    }
    renderRule(rule, backButton());
  } catch (err) {
    mount(backButton(), h("div", { class: "banner danger" }, `Failed to load rule — ${err instanceof Error ? err.message : String(err)}`));
  }
}

function backButton(): HTMLElement | null {
  if (!listRows.length) return null;
  const b = h("button", { class: "btn ghost", type: "button" }, "‹ Back to list");
  b.addEventListener("click", () => renderList());
  return h("div", null, b);
}

const KIND_VARIANT: Record<string, "info" | "warning" | "success" | undefined> = {
  TRIGGER: "info",
  CONDITION: "warning",
  ACTION: "success",
};

function componentChildren(c: RuleComponent): RuleComponent[] {
  const out: RuleComponent[] = [];
  for (const key of ["children", "conditions", "components"] as const) {
    const arr = (c as Record<string, unknown>)[key];
    if (Array.isArray(arr)) out.push(...arr.filter(isRecord));
  }
  return out;
}

function renderNode(c: RuleComponent): HTMLElement {
  const kind = typeof c.component === "string" ? c.component : "COMPONENT";
  const li = h("li", null);
  const node = h("div", { class: "node" }, chip(kind, KIND_VARIANT[kind]));
  if (typeof c.type === "string") node.append(h("span", { class: "type" }, c.type));
  if (c.value !== undefined) {
    const preview = fmtCompact(c.value, 160);
    node.append(preview.length >= 40 ? collapse(h("span", null, preview), jsonBlock(c.value)) : h("span", { class: "hint" }, preview));
  }
  li.append(node);
  const children = componentChildren(c);
  if (children.length) {
    const ul = h("ul", { class: "tree" });
    for (const child of children) ul.append(renderNode(child));
    li.append(ul);
  }
  return li;
}

function renderRule(rule: RuleDoc, back: HTMLElement | null): void {
  const wrap = h("div", { class: "stack" });
  if (back) wrap.append(back);

  const title = h("div", { class: "h-title" }, typeof rule.name === "string" ? rule.name : "Automation rule", stateChip(rule.state));
  wrap.append(title);
  const id = ruleIdOf(rule as Record<string, unknown>);
  if (id) wrap.append(h("div", { class: "h-sub" }, codeInline(id)));
  if (typeof rule.description === "string" && rule.description) wrap.append(h("div", { class: "h-sub" }, rule.description));
  if (rule.ruleScope !== undefined) {
    wrap.append(collapse(h("span", null, "Scope"), jsonBlock(rule.ruleScope)));
  }

  const tree = h("ul", { class: "tree" });
  if (isRecord(rule.trigger)) tree.append(renderNode({ component: "TRIGGER", ...rule.trigger }));
  for (const c of (rule.components ?? []).filter(isRecord)) tree.append(renderNode(c));
  if (!tree.childElementCount) {
    wrap.append(h("div", { class: "state" }, "Rule has no trigger or components."));
  } else {
    wrap.append(tree);
  }

  wrap.append(collapse(h("span", null, "Raw rule JSON"), jsonBlock(rule)));
  mount(wrap);
}

mount(renderLoading("Waiting for automation data…"));

void initView("gojira-automation-rule", {
  onArgs: (args) => {
    lastArgs = args;
  },
  onResult: renderParsed,
  onCancelled: (reason) => mount(h("div", { class: "state" }, `Tool call cancelled${reason ? ` — ${reason}` : ""}.`)),
}).then((a) => {
  app = a;
  // Results can land before the handshake resolves; re-render so row drill-in
  // and "Load more" become live.
  if (listRows.length) renderList();
});
