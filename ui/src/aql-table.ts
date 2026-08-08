/**
 * Assets AQL results — attached to assets.aqlSearch. Objects come back with
 * per-object-type dynamic attribute sets, so columns are discovered from the
 * response (objectTypeAttributes when present, attribute ids otherwise) with
 * a column picker, per-page sort, and server-side paging via re-invocation.
 */
import { h, chip, clear, codeInline, collapse, jsonBlock } from "./shared/dom.js";
import type { ParsedResult } from "./shared/envelope.js";
import { callTool, initView, type App } from "./shared/host.js";
import { renderErrorCard, renderLoading } from "./shared/render.js";

interface AttrValue {
  value?: unknown;
  displayValue?: unknown;
  searchValue?: unknown;
  referencedObject?: { label?: string; objectKey?: string };
  status?: { name?: string };
  user?: { displayName?: string };
}

interface ObjectEntry {
  id?: unknown;
  objectKey?: string;
  label?: string;
  objectType?: { name?: string };
  attributes?: Array<{ objectTypeAttributeId?: unknown; objectAttributeValues?: AttrValue[] }>;
}

interface AqlView {
  entries: ObjectEntry[];
  columns: Array<{ id: string; name: string }>;
  total: number | null;
  startAt: number;
  pageSize: number;
}

const DEFAULT_VISIBLE_COLUMNS = 6;

const root = document.getElementById("app")!;
let app: App | null = null;
let lastArgs: Record<string, unknown> | null = null;
let view: AqlView | null = null;
let rawResult: unknown = null;
const visibleCols = new Map<string, boolean>();
let sort: { col: string; dir: 1 | -1 } | null = null;
let paging = false;

function mount(...nodes: Array<HTMLElement | null>): void {
  clear(root);
  for (const n of nodes) if (n) root.append(n);
  root.removeAttribute("aria-busy");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function attrDisplay(values: AttrValue[] | undefined): string {
  if (!values?.length) return "";
  return values
    .map(
      (v) =>
        v.displayValue ??
        v.referencedObject?.label ??
        v.referencedObject?.objectKey ??
        v.status?.name ??
        v.user?.displayName ??
        v.value ??
        v.searchValue ??
        "",
    )
    .filter((s) => s !== "" && s !== undefined && s !== null)
    .map(String)
    .join(", ");
}

function buildView(result: unknown): AqlView | null {
  if (!isRecord(result)) return null;
  const entries = (
    Array.isArray(result.values) ? result.values : Array.isArray(result.objectEntries) ? result.objectEntries : []
  ).filter(isRecord) as ObjectEntry[];

  // Column order follows the schema's attribute definitions when the response
  // includes them; ids seen only on objects are appended after.
  const columns: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  const defs = Array.isArray(result.objectTypeAttributes) ? result.objectTypeAttributes : [];
  for (const d of defs) {
    if (!isRecord(d) || d.id === undefined) continue;
    const id = String(d.id);
    if (seen.has(id)) continue;
    seen.add(id);
    columns.push({ id, name: typeof d.name === "string" ? d.name : `#${id}` });
  }
  for (const e of entries) {
    for (const a of e.attributes ?? []) {
      if (a?.objectTypeAttributeId === undefined) continue;
      const id = String(a.objectTypeAttributeId);
      if (seen.has(id)) continue;
      seen.add(id);
      columns.push({ id, name: `#${id}` });
    }
  }

  const pageSizeArg = Number(lastArgs?.resultPerPage);
  const pageArg = Number(lastArgs?.page);
  const pageSize =
    Number(result.maxResults) || Number(result.pageSize) || (Number.isFinite(pageSizeArg) ? pageSizeArg : 0) || entries.length || 25;
  const startAt = Number.isFinite(Number(result.startAt))
    ? Number(result.startAt)
    : ((Number.isFinite(pageArg) && pageArg > 0 ? pageArg : 1) - 1) * pageSize;
  const totalRaw = result.total ?? result.totalFilterCount;
  const total = Number.isFinite(Number(totalRaw)) ? Number(totalRaw) : null;
  return { entries, columns, total, startAt, pageSize };
}

function cellValue(e: ObjectEntry, colId: string): string {
  const attr = e.attributes?.find((a) => String(a?.objectTypeAttributeId) === colId);
  return attrDisplay(attr?.objectAttributeValues);
}

function renderParsed(parsed: ParsedResult): void {
  if (parsed.isError) {
    mount(renderErrorCard(parsed.envelope));
    return;
  }
  rawResult = parsed.result;
  view = buildView(parsed.result);
  sort = null;
  if (view) {
    view.columns.forEach((c, i) => {
      if (!visibleCols.has(c.id)) visibleCols.set(c.id, i < DEFAULT_VISIBLE_COLUMNS);
    });
  }
  render();
}

function render(): void {
  if (!view) {
    mount(
      h("div", { class: "state" }, "Unrecognized AQL response shape."),
      collapse(h("span", null, "Raw result"), jsonBlock(rawResult)),
    );
    return;
  }
  const wrap = h("div", { class: "stack" });

  const query = typeof lastArgs?.qlQuery === "string" ? lastArgs.qlQuery : null;
  wrap.append(
    h(
      "div",
      { class: "toolbar" },
      h("div", { class: "h-title" }, "AQL results", view.total !== null ? chip(`${view.total} total`) : null),
      view.columns.length ? renderColumnPicker() : null,
    ),
  );
  if (query) wrap.append(h("div", { class: "query-line", title: "AQL query" }, query));

  if (!view.entries.length) {
    wrap.append(h("div", { class: "state" }, "No objects matched."));
    mount(wrap);
    return;
  }

  wrap.append(renderTable());
  wrap.append(renderPager());
  mount(wrap);
}

function renderColumnPicker(): HTMLElement {
  const body = h("div", { class: "stack" });
  for (const c of view!.columns) {
    const cb = h("input", {
      type: "checkbox",
      checked: visibleCols.get(c.id) || null,
    }) as HTMLInputElement;
    cb.addEventListener("change", () => {
      visibleCols.set(c.id, cb.checked);
      render();
    });
    body.append(h("label", { style: "display:flex;gap:6px;align-items:center;" }, cb, c.name));
  }
  return collapse(h("span", null, "Columns"), body);
}

function sortedEntries(): ObjectEntry[] {
  const entries = [...view!.entries];
  if (!sort) return entries;
  const { col, dir } = sort;
  const key = (e: ObjectEntry): string =>
    col === "__key" ? (e.objectKey ?? "") : col === "__label" ? (e.label ?? "") : col === "__type" ? (e.objectType?.name ?? "") : cellValue(e, col);
  return entries.sort((a, b) => {
    const av = key(a);
    const bv = key(b);
    const an = Number(av);
    const bn = Number(bv);
    if (av !== "" && bv !== "" && Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * dir;
    return av.localeCompare(bv, undefined, { sensitivity: "base" }) * dir;
  });
}

function sortableTh(label: string, col: string): HTMLElement {
  const active = sort?.col === col;
  const th = h(
    "th",
    { class: "sortable", title: "Sort (current page only)" },
    label,
    active ? h("span", { class: "arrow" }, sort!.dir === 1 ? "▲" : "▼") : null,
  );
  th.addEventListener("click", () => {
    sort = active && sort!.dir === 1 ? { col, dir: -1 } : { col, dir: 1 };
    render();
  });
  return th;
}

function renderTable(): HTMLElement {
  const cols = view!.columns.filter((c) => visibleCols.get(c.id));
  const head = h(
    "tr",
    null,
    sortableTh("Key", "__key"),
    sortableTh("Label", "__label"),
    sortableTh("Type", "__type"),
    ...cols.map((c) => sortableTh(c.name, c.id)),
  );
  const tbody = h("tbody", null);
  for (const e of sortedEntries()) {
    const row = h(
      "tr",
      { class: "clickable", title: "Show raw object" },
      h("td", { class: "nowrap" }, e.objectKey ? codeInline(e.objectKey) : "—"),
      h("td", null, e.label ?? "—"),
      h("td", null, e.objectType?.name ?? "—"),
      ...cols.map((c) => h("td", null, cellValue(e, c.id) || "—")),
    );
    const detail = h("tr", { hidden: true }, h("td", { colspan: String(3 + cols.length) }, jsonBlock(e)));
    row.addEventListener("click", () => {
      detail.hidden = !detail.hidden;
    });
    tbody.append(row, detail);
  }
  return h("div", { class: "table-wrap" }, h("table", { class: "grid" }, h("thead", null, head), tbody));
}

function renderPager(): HTMLElement {
  const v = view!;
  const from = v.startAt + 1;
  const to = v.startAt + v.entries.length;
  const label = v.total !== null ? `${from}–${to} of ${v.total}` : `${from}–${to}`;
  const pager = h("div", { class: "pager" }, h("span", null, label));
  if (!app || !lastArgs || typeof lastArgs.qlQuery !== "string") return pager;

  const currentPage = Math.floor(v.startAt / v.pageSize) + 1;
  const hasPrev = currentPage > 1;
  const hasNext = v.total !== null ? v.startAt + v.entries.length < v.total : v.entries.length === v.pageSize;

  const mk = (text: string, enabled: boolean, page: number): HTMLElement => {
    const b = h("button", { class: "btn ghost", type: "button", disabled: !enabled || paging || null }, text);
    b.addEventListener("click", () => void goToPage(page));
    return b;
  };
  pager.prepend(mk("‹ Prev", hasPrev, currentPage - 1));
  pager.append(mk("Next ›", hasNext, currentPage + 1));
  return pager;
}

async function goToPage(page: number): Promise<void> {
  if (!app || !lastArgs || paging) return;
  paging = true;
  render();
  try {
    const args = { ...lastArgs, page };
    const parsed = await callTool(app, "assets.aqlSearch", args);
    // Clear before rendering, or the freshly-rendered pager draws disabled.
    paging = false;
    if (parsed.isError) {
      mount(renderErrorCard(parsed.envelope));
      return;
    }
    lastArgs = args;
    renderParsed(parsed);
  } catch (err) {
    paging = false;
    mount(h("div", { class: "banner danger" }, `Paging failed — ${err instanceof Error ? err.message : String(err)}`));
  }
}

mount(renderLoading("Waiting for AQL results…"));

void initView("gojira-aql-table", {
  onArgs: (args) => {
    lastArgs = args;
  },
  onResult: renderParsed,
  onCancelled: (reason) => mount(h("div", { class: "state" }, `Tool call cancelled${reason ? ` — ${reason}` : ""}.`)),
}).then((a) => {
  app = a;
  // Results can land before the handshake resolves; re-render so paging becomes live.
  if (view) render();
});
