import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";
import { parseToolResult, type ParsedResult } from "./envelope.js";

export interface ViewCallbacks {
  /** Original tool arguments — the host replays these on load. */
  onArgs?(args: Record<string, unknown>): void;
  onResult(parsed: ParsedResult): void;
  onCancelled?(reason?: string): void;
}

interface HostContextLike {
  theme?: string;
  styles?: { variables?: Record<string, string | undefined>; css?: { fonts?: string } };
}

function applyHostStyles(app: App): void {
  const ctx = app.getHostContext() as HostContextLike | undefined;
  if (!ctx) return;
  const root = document.documentElement;
  if (ctx.theme === "light" || ctx.theme === "dark") root.dataset.theme = ctx.theme;
  const vars = ctx.styles?.variables;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v === "string" && k.startsWith("--")) root.style.setProperty(k, v);
    }
  }
  const fonts = ctx.styles?.css?.fonts;
  if (fonts && !document.getElementById("host-fonts")) {
    const style = document.createElement("style");
    style.id = "host-fonts";
    style.textContent = fonts;
    document.head.appendChild(style);
  }
}

/**
 * Standard view bootstrap: handlers registered before connect() (the host
 * replays tool-input/tool-result for an already-completed call), host theme
 * and style tokens applied, auto-resize left at the App default (on).
 */
export async function initView(name: string, cb: ViewCallbacks): Promise<App> {
  const app = new App({ name, version: "0.1.0" }, {});
  app.ontoolinput = (p) => {
    const args = (p as { arguments?: Record<string, unknown> } | undefined)?.arguments;
    if (args) cb.onArgs?.(args);
  };
  app.ontoolresult = (p) => cb.onResult(parseToolResult(p));
  app.ontoolcancelled = (p) => cb.onCancelled?.((p as { reason?: string } | undefined)?.reason);
  app.onhostcontextchanged = () => applyHostStyles(app);
  await app.connect();
  applyHostStyles(app);
  return app;
}

/** App-initiated tool call, parsed into the gojira envelope. */
export async function callTool(
  app: App,
  name: string,
  args: Record<string, unknown>,
): Promise<ParsedResult> {
  const res = await app.callServerTool({ name, arguments: args });
  return parseToolResult(res);
}

/**
 * Best-effort note to the conversation model about something the user did in
 * the view (e.g. committed an operation). Hosts may not support it; failure
 * changes nothing about the view itself.
 */
export function tellModel(app: App, text: string): void {
  void app.updateModelContext({ content: [{ type: "text", text }] }).catch(() => undefined);
}

export type { App };
