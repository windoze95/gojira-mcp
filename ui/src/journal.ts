/**
 * Operation journal — attached to gojira.listRecentOperations (timeline) and
 * gojira.getOperation (single entry). Rows expand into full detail with a
 * client-computed before/after patch; revertible entries carry a dry-run-first
 * revert flow that reuses the shared diff renderers.
 */
import { h, chip, clear, codeInline, collapse, jsonBlock, relTime, spinner } from "./shared/dom.js";
import { isDryRun, type ParsedResult } from "./shared/envelope.js";
import { generateJsonPatch } from "./shared/jsondiff.js";
import { callTool, initView, tellModel, type App } from "./shared/host.js";
import {
  renderDiff,
  renderErrorCard,
  renderLoading,
  renderPatchTable,
  renderTarget,
} from "./shared/render.js";

interface EntrySummary {
  opId: string;
  tool: string;
  target?: { kind?: string; id?: string; key?: string; name?: string } & Record<string, unknown>;
  completedAt?: string;
  outcome?: string;
  revertible?: boolean;
  errorCode?: string | null;
}

interface EntryDetail extends EntrySummary {
  before?: unknown;
  after?: unknown;
  request?: Record<string, unknown>;
  requestedAt?: string;
  cloudId?: string | null;
  revertHint?: string;
  errorMessage?: string;
}

const root = document.getElementById("app")!;
let app: App | null = null;
let lastArgs: Record<string, unknown> | null = null;

function mount(...nodes: Array<HTMLElement | null>): void {
  clear(root);
  for (const n of nodes) if (n) root.append(n);
  root.removeAttribute("aria-busy");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Accepts both the list rows (snake_case) and JournalEntry (camelCase). */
function normalizeEntry(v: Record<string, unknown>): EntryDetail {
  return {
    opId: String(v.opId ?? v.op_id ?? ""),
    tool: String(v.tool ?? ""),
    target: isRecord(v.target) ? (v.target as EntryDetail["target"]) : undefined,
    completedAt: (v.completedAt ?? v.completed_at) as string | undefined,
    requestedAt: (v.requestedAt ?? v.requested_at) as string | undefined,
    outcome: v.outcome as string | undefined,
    revertible: v.revertible === true,
    errorCode: (v.errorCode ?? v.error_code ?? null) as string | null,
    errorMessage: (v.errorMessage ?? v.error_message) as string | undefined,
    before: v.before,
    after: v.after,
    request: isRecord(v.request) ? v.request : undefined,
    cloudId: (v.cloudId ?? v.cloud_id ?? null) as string | null,
    revertHint: (v.revertHint ?? v.revert_hint) as string | undefined,
  };
}

function outcomeChip(outcome: string | undefined): HTMLElement {
  const o = outcome ?? "unknown";
  const variant = o === "success" ? "success" : o === "failure" ? "danger" : undefined;
  return chip(o, variant);
}

function targetSummary(target: EntrySummary["target"]): string {
  if (!target) return "—";
  const label = target.name ?? target.key ?? target.id ?? "—";
  return target.kind ? `${target.kind} · ${label}` : String(label);
}

function renderParsed(parsed: ParsedResult): void {
  if (parsed.isError) {
    mount(renderErrorCard(parsed.envelope));
    return;
  }
  const r = parsed.result;
  if (isRecord(r) && Array.isArray(r.entries)) {
    renderList(r.entries.filter(isRecord).map(normalizeEntry), Number(r.count ?? r.entries.length));
    return;
  }
  if (isRecord(r) && (r.opId !== undefined || r.op_id !== undefined)) {
    mount(h("div", { class: "stack" }, renderDetail(normalizeEntry(r))));
    return;
  }
  mount(h("div", { class: "state" }, "Nothing to display."), collapse(h("span", null, "Raw result"), jsonBlock(r)));
}

function renderList(entries: EntryDetail[], count: number): void {
  const wrap = h("div", { class: "stack" });

  const refreshBtn = h("button", { class: "btn ghost", type: "button" }, "Refresh");
  refreshBtn.addEventListener("click", () => void refresh(refreshBtn));
  wrap.append(
    h(
      "div",
      { class: "toolbar" },
      h("div", { class: "h-title" }, "Recent operations", chip(String(count))),
      app && lastArgs !== null ? refreshBtn : null,
    ),
  );

  if (!entries.length) {
    wrap.append(h("div", { class: "state" }, "No journaled operations in this window."));
    mount(wrap);
    return;
  }

  const tbody = h("tbody", null);
  for (const e of entries) {
    const row = h(
      "tr",
      { class: "clickable", title: "Show detail" },
      h("td", null, h("span", { class: `dot ${e.outcome ?? "dry_run"}` }), " ", outcomeChip(e.outcome)),
      h("td", null, codeInline(e.tool)),
      h("td", null, targetSummary(e.target)),
      h("td", null, relTime(e.completedAt)),
      h("td", null, e.revertible ? chip("revertible", "info") : e.errorCode ? chip(e.errorCode, "danger") : null),
    );
    const detailRow = h("tr", { hidden: true }, h("td", { colspan: "5" }));
    row.addEventListener("click", () => void toggleDetail(e, row, detailRow));
    tbody.append(row, detailRow);
  }
  wrap.append(
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "grid" },
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            h("th", null, "Outcome"),
            h("th", null, "Tool"),
            h("th", null, "Target"),
            h("th", null, "Completed"),
            h("th", null, ""),
          ),
        ),
        tbody,
      ),
    ),
  );
  mount(wrap);
}

async function refresh(btn: HTMLButtonElement): Promise<void> {
  if (!app) return;
  btn.disabled = true;
  try {
    renderParsed(await callTool(app, "gojira.listRecentOperations", lastArgs ?? {}));
  } catch {
    btn.disabled = false;
  }
}

async function toggleDetail(e: EntryDetail, row: HTMLTableRowElement, detailRow: HTMLTableRowElement): Promise<void> {
  if (!detailRow.hidden) {
    detailRow.hidden = true;
    return;
  }
  detailRow.hidden = false;
  const cell = detailRow.firstElementChild as HTMLTableCellElement;
  // The list rows don't carry before/after — fetch the full entry once.
  if (!cell.dataset.loaded) {
    cell.replaceChildren(renderLoading("Loading entry…"));
    if (!app) return;
    try {
      const parsed = await callTool(app, "gojira.getOperation", { op_id: e.opId });
      if (parsed.isError || !isRecord(parsed.result)) {
        cell.replaceChildren(renderErrorCard(parsed.envelope));
        return;
      }
      cell.dataset.loaded = "1";
      cell.replaceChildren(renderDetail(normalizeEntry(parsed.result)));
    } catch (err) {
      cell.replaceChildren(
        h("div", { class: "banner danger" }, `Failed to load entry — ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }
  row.setAttribute("aria-expanded", String(!detailRow.hidden));
}

function renderDetail(e: EntryDetail): HTMLElement {
  const wrap = h("div", { class: "stack" });
  wrap.append(
    h("div", { class: "h-title" }, outcomeChip(e.outcome), codeInline(e.tool), h("span", { class: "hint" }, e.opId)),
  );
  const target = renderTarget(e.target);
  if (target) wrap.append(target);

  const kv = h("dl", { class: "kv" });
  if (e.completedAt) kv.append(h("dt", null, "Completed"), h("dd", null, relTime(e.completedAt)));
  if (e.cloudId) kv.append(h("dt", null, "Cloud id"), h("dd", null, codeInline(e.cloudId)));
  if (e.errorCode) kv.append(h("dt", null, "Error"), h("dd", null, chip(e.errorCode, "danger"), e.errorMessage ? ` ${e.errorMessage}` : ""));
  wrap.append(kv);

  if (e.request) wrap.append(collapse(h("span", null, "Request"), jsonBlock(e.request)));

  if (e.before !== undefined || e.after !== undefined) {
    const patch = generateJsonPatch(e.before ?? null, e.after ?? null);
    if (patch.length) {
      wrap.append(h("div", { class: "hint" }, "Change applied by this operation:"), renderPatchTable(patch));
    }
    wrap.append(collapse(h("span", null, "Before / after snapshots"), h("div", null, jsonBlock({ before: e.before, after: e.after }))));
  }

  if (e.revertible) wrap.append(renderRevertSection(e));
  else if (e.revertHint) wrap.append(h("div", { class: "hint" }, e.revertHint));
  return wrap;
}

function renderRevertSection(e: EntryDetail): HTMLElement {
  const section = h("div", { class: "stack" });
  const btn = h("button", { class: "btn", type: "button" }, "Revert…");
  btn.addEventListener("click", () => void previewRevert(e, section, btn));
  section.append(h("div", { class: "actions" }, btn, h("span", { class: "hint" }, "Dry-run first — nothing changes until you confirm.")));
  return section;
}

async function previewRevert(e: EntryDetail, section: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  if (!app) return;
  btn.disabled = true;
  btn.replaceChildren(spinner(), "Previewing…");
  try {
    const parsed = await callTool(app, "gojira.revertOperation", { op_id: e.opId });
    if (parsed.isError) {
      section.replaceChildren(renderErrorCard(parsed.envelope));
      return;
    }
    if (!isDryRun(parsed.result)) {
      section.replaceChildren(h("div", { class: "banner info" }, "Revert returned no dry-run preview."), jsonBlock(parsed.result));
      return;
    }
    const dry = parsed.result;
    const confirm = h("button", { class: "btn danger", type: "button" }, "Confirm revert");
    confirm.addEventListener("click", () => void commitRevert(e, section, confirm));
    section.replaceChildren(
      h("div", { class: "banner warning" }, dry.message ?? `Would revert ${e.tool}.`),
      renderDiff(dry.diff),
      h("div", { class: "actions" }, confirm),
    );
  } catch (err) {
    section.replaceChildren(
      h("div", { class: "banner danger" }, `Revert preview failed — ${err instanceof Error ? err.message : String(err)}`),
    );
  }
}

async function commitRevert(e: EntryDetail, section: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  if (!app) return;
  btn.disabled = true;
  btn.replaceChildren(spinner(), "Reverting…");
  try {
    const parsed = await callTool(app, "gojira.revertOperation", { op_id: e.opId, commit: true });
    if (parsed.isError) {
      section.replaceChildren(renderErrorCard(parsed.envelope));
      return;
    }
    const r = parsed.result as Record<string, unknown> | undefined;
    const journalId = r && typeof r.journal_id === "string" ? r.journal_id : null;
    section.replaceChildren(
      h(
        "div",
        { class: "banner success" },
        h("strong", null, "Reverted"),
        journalId ? h("span", null, " — new journal entry ", codeInline(journalId)) : null,
      ),
    );
    tellModel(app, `User reverted operation ${e.opId} (${e.tool}) from the journal view${journalId ? `; revert journaled as ${journalId}` : ""}.`);
  } catch (err) {
    section.replaceChildren(
      h("div", { class: "banner danger" }, `Revert failed — ${err instanceof Error ? err.message : String(err)}`),
    );
  }
}

mount(renderLoading("Waiting for journal data…"));

void initView("gojira-journal", {
  onArgs: (args) => {
    lastArgs = args;
  },
  onResult: renderParsed,
  onCancelled: (reason) => mount(h("div", { class: "state" }, `Tool call cancelled${reason ? ` — ${reason}` : ""}.`)),
}).then((a) => {
  app = a;
});
