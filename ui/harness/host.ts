/**
 * Local render harness — a minimal MCP Apps *host*.
 *
 * Loads a built template into an iframe and drives the real postMessage
 * JSON-RPC bridge with `AppBridge`: initialize handshake, host theme/style
 * tokens, tool-input + tool-result notifications, and fixture-backed
 * responses to view-initiated `tools/call`. No Atlassian tenant, no OAuth,
 * no Redis — but the exact bridge code path a real host uses.
 *
 *   npm run ui:harness   →   http://localhost:5174/?scenario=<id>&theme=<t>
 */
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { SCENARIOS, type Scenario } from "./fixtures.js";

const params = new URLSearchParams(location.search);
const scenarioId = params.get("scenario") ?? "";
const theme = params.get("theme") === "dark" ? "dark" : "light";
const chrome = params.get("chrome") !== "off";

document.documentElement.dataset.theme = theme;

const root = document.getElementById("harness")!;
if (!chrome) root.classList.add("bare");

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...kids: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...kids);
  return node;
}

if (!SCENARIOS[scenarioId]) {
  const list = el("ul", { class: "index" });
  for (const [id, s] of Object.entries(SCENARIOS)) {
    list.append(
      el(
        "li",
        {},
        el("a", { href: `?scenario=${id}&theme=${theme}` }, s.label),
        el("span", { class: "meta" }, ` ui://gojira/${s.view}.html`),
      ),
    );
  }
  root.append(el("h1", {}, "gojira-mcp · MCP Apps render harness"), list);
} else {
  void mount(scenarioId, SCENARIOS[scenarioId]);
}

/** Mirrors the host style tokens Claude injects into a rendered app. */
function hostStyles(): Record<string, string> {
  return theme === "dark"
    ? {
        "--color-background-primary": "#1f2126",
        "--color-background-secondary": "#26292f",
        "--color-background-tertiary": "#2f333a",
        "--color-text-primary": "#e9eaec",
        "--color-text-secondary": "#a7abb3",
        "--color-text-tertiary": "#7e838c",
        "--color-border-primary": "#3c4048",
        "--color-border-secondary": "#33363d",
      }
    : {
        "--color-background-primary": "#ffffff",
        "--color-background-secondary": "#f5f6f7",
        "--color-background-tertiary": "#ebedef",
        "--color-text-primary": "#1f2126",
        "--color-text-secondary": "#5c626c",
        "--color-text-tertiary": "#878d97",
        "--color-border-primary": "#d8dbe0",
        "--color-border-secondary": "#e6e8eb",
      };
}

async function mount(id: string, scenario: Scenario): Promise<void> {
  if (chrome) {
    root.append(
      el(
        "header",
        { class: "bar" },
        el("a", { href: `?theme=${theme}`, class: "back" }, "‹ all views"),
        el("span", { class: "label" }, scenario.label),
        el("code", {}, `ui://gojira/${scenario.view}.html`),
      ),
    );
  }

  // No src yet: the view sends ui/initialize the moment it loads, so the
  // bridge must be listening first or that request is lost (the view then
  // renders notifications but never completes its handshake). Real hosts
  // own the iframe and are always listening before the resource loads.
  const frame = el("iframe", {
    id: "view",
    // Same sandbox flags a host applies per the MCP Apps spec.
    sandbox: "allow-scripts allow-same-origin",
    title: scenario.label,
  });
  root.append(chrome ? el("div", { class: "frame-wrap" }, frame) : frame);

  const bridge = new AppBridge(
    null,
    { name: "gojira-harness", version: "0.1.0" },
    { serverTools: {}, openLinks: {}, logging: {} },
    {
      hostContext: {
        theme,
        styles: { variables: hostStyles() },
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen"],
        platform: "web",
        locale: "en-US",
        userAgent: "gojira-harness",
      },
    },
  );

  // No MCP client behind this bridge — fixtures answer the view's calls, so
  // interactive paths (commit, revert, paging, drill-in) work end to end.
  bridge.oncalltool = async (req) => {
    const fixture = scenario.calls?.[req.name];
    if (fixture === undefined) {
      const err = { success: false, error: { code: "NOT_IMPLEMENTED", message: `No harness fixture for '${req.name}'` } };
      return { content: [{ type: "text", text: JSON.stringify(err, null, 2) }], structuredContent: err, isError: true };
    }
    const payload = typeof fixture === "function" ? fixture((req.arguments ?? {}) as Record<string, unknown>) : fixture;
    const envelope = { success: true, result: payload };
    // Deliberate latency so in-flight states (spinners, disabled buttons) are
    // observable and screenshotable.
    await new Promise((r) => setTimeout(r, 220));
    return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }], structuredContent: envelope };
  };
  bridge.onupdatemodelcontext = async (p) => {
    console.log("[harness] updateModelContext:", JSON.stringify(p));
    return {};
  };
  bridge.onopenlink = async ({ url }) => {
    console.log("[harness] openLink:", url);
    return {};
  };
  // Hosts size the frame from ui/notifications/size-changed. Same-origin here,
  // so also measure directly: the notification can lag a render, and the
  // screenshot driver needs the frame settled at full content height.
  const fit = (height?: number): void => {
    const measured = frame.contentDocument?.documentElement?.scrollHeight ?? 0;
    const h = Math.max(height ?? 0, measured);
    if (h > 0) frame.style.height = `${h}px`;
  };
  bridge.addEventListener("sizechange", ({ height }) => fit(typeof height === "number" ? height : undefined));

  // WindowProxy identity survives same-origin navigation, so a transport bound
  // to the blank frame keeps matching once the template loads.
  await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));

  await new Promise<void>((resolve) => {
    frame.addEventListener("load", () => resolve(), { once: true });
    frame.src = `/dist/${scenario.view}.html`;
  });
  const frameDoc = frame.contentDocument;
  if (frameDoc) new ResizeObserver(() => fit()).observe(frameDoc.documentElement);
  // Let the view finish its ui/initialize handshake before results arrive.
  await new Promise((r) => setTimeout(r, 150));

  await bridge.sendToolInput({ arguments: scenario.toolArgs });

  const envelope = scenario.error
    ? { success: false, error: scenario.error }
    : { success: true, result: scenario.result };
  await bridge.sendToolResult({
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
    ...(scenario.error ? { isError: true } : {}),
  });

  // The view renders its result asynchronously and the iframe's own box never
  // changes (it's what we're sizing), so a ResizeObserver alone can miss it —
  // settle with a few delayed measurements.
  for (const delay of [0, 60, 200, 450]) {
    await new Promise((r) => setTimeout(r, delay));
    fit();
  }
  // Screenshot driver waits on this instead of racing the bridge.
  const w = window as unknown as { harnessFit?: () => void; harnessBridge?: AppBridge };
  w.harnessFit = () => fit();
  w.harnessBridge = bridge;
  document.documentElement.dataset.harnessReady = "1";
  console.log(`[harness] scenario '${id}' delivered`);
}
