/**
 * Confirm-op card — the default view for every destructive (commit-positive)
 * tool. Renders the dry-run diff with a Commit action that re-invokes the
 * same tool with the original arguments plus `commit: true`; also renders
 * committed results and error envelopes for calls that skipped the dry-run.
 */
import { h, chip, clear, codeInline, spinner } from "./shared/dom.js";
import { isDryRun, type DryRunPayload, type ParsedResult } from "./shared/envelope.js";
import { callTool, initView, tellModel, type App } from "./shared/host.js";
import {
  renderDiff,
  renderErrorCard,
  renderLoading,
  renderResultCard,
  renderTarget,
} from "./shared/render.js";

const root = document.getElementById("app")!;
let app: App | null = null;
let lastArgs: Record<string, unknown> | null = null;
let lastParsed: ParsedResult | null = null;

function mount(...nodes: Array<HTMLElement | null>): void {
  clear(root);
  for (const n of nodes) if (n) root.append(n);
  root.removeAttribute("aria-busy");
}

function renderParsed(parsed: ParsedResult): void {
  lastParsed = parsed;
  if (parsed.isError) {
    mount(renderErrorCard(parsed.envelope));
    return;
  }
  if (isDryRun(parsed.result)) {
    renderDryRunCard(parsed.result);
    return;
  }
  mount(renderResultCard(parsed.result));
}

function renderDryRunCard(dry: DryRunPayload): void {
  const message = dry.message ?? "This call would mutate Atlassian state.";
  // The server writes intent into the message; the card only amplifies it.
  const permanent = /PERMANENTLY|NO UNDO/i.test(message);
  const card = h("div", { class: "stack" });

  const title = h("div", { class: "h-title" }, chip("Dry run", "info"));
  if (dry.tool) title.append(codeInline(dry.tool));
  if (dry.original?.tool) title.append(h("span", { class: "hint" }, `reverts ${dry.original.tool}`));
  card.append(title);

  const banner = h("div", { class: permanent ? "banner danger" : "banner warning" });
  if (permanent) banner.append(chip("NO UNDO", "danger"), " ");
  banner.append(message);
  card.append(banner);

  const target = renderTarget(dry.target);
  if (target) card.append(target);

  card.append(renderDiff(dry.diff));

  const actions = h("div", { class: "actions" });
  // Gate on `app` too: a result can arrive before the ui/initialize handshake
  // resolves, and committing needs a live bridge. The view re-renders once
  // initView resolves, so the button enables on its own.
  const canCommit = Boolean(dry.tool && lastArgs && app);
  const btn = h(
    "button",
    { class: "btn danger", type: "button", disabled: !canCommit || null },
    permanent ? "Commit — apply permanently" : "Commit — apply this change",
  );
  const hint = h(
    "span",
    { class: "hint" },
    canCommit
      ? (dry.commit_hint ?? "Nothing changes until you commit.")
      : !app
        ? "Connecting to the host…"
        : "Original call context unavailable — ask in chat to re-invoke with commit: true.",
  );
  btn.addEventListener("click", () => void commit(dry, btn));
  actions.append(btn, hint);
  card.append(actions);

  mount(card);
}

async function commit(dry: DryRunPayload, btn: HTMLButtonElement): Promise<void> {
  if (!app || !dry.tool || !lastArgs) return;
  btn.disabled = true;
  btn.replaceChildren(spinner(), "Committing…");
  try {
    const parsed = await callTool(app, dry.tool, { ...lastArgs, commit: true });
    renderParsed(parsed);
    if (!parsed.isError) {
      const r = parsed.result as Record<string, unknown> | undefined;
      const journalId = r && typeof r.journal_id === "string" ? ` (journal ${r.journal_id})` : "";
      tellModel(app, `User committed ${dry.tool} from the confirm card${journalId}.`);
    }
  } catch (err) {
    mount(
      h(
        "div",
        { class: "banner danger" },
        h("strong", null, "Commit failed"),
        ` — ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }
}

mount(renderLoading("Waiting for tool result…"));

void initView("gojira-confirm-op", {
  onArgs: (args) => {
    lastArgs = args;
  },
  onResult: renderParsed,
  onCancelled: (reason) =>
    mount(h("div", { class: "state" }, `Tool call cancelled${reason ? ` — ${reason}` : ""}.`)),
}).then((a) => {
  app = a;
  // Results can land before the handshake resolves; re-render so actions that
  // need the bridge become live.
  if (lastParsed) renderParsed(lastParsed);
});
