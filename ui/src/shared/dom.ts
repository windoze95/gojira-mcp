/** Tiny DOM helpers. Everything renders through textContent — no innerHTML —
 * so upstream Atlassian data can never inject markup into the view. */

export type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, unknown> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2), v as EventListener);
      } else if (k === "class") {
        el.className = String(v);
      } else if (v === true) {
        el.setAttribute(k, "");
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  append(el, ...children);
  return el;
}

export function append(el: Element, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void {
  el.textContent = "";
}

export function chip(text: string, variant?: "danger" | "success" | "warning" | "info"): HTMLSpanElement {
  return h("span", { class: variant ? `chip ${variant}` : "chip" }, text);
}

export function codeInline(text: string): HTMLElement {
  return h("code", { class: "inline" }, text);
}

export function spinner(): HTMLSpanElement {
  return h("span", { class: "spinner", "aria-hidden": "true" });
}

export function collapse(summary: Child, body: Node, open = false): HTMLDetailsElement {
  const d = h("details", { class: "collapse", open: open || null });
  d.append(h("summary", null, summary), body);
  return d;
}

export function jsonBlock(value: unknown): HTMLPreElement {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return h("pre", { class: "json" }, text);
}

/** Single-line JSON preview, truncated. */
export function fmtCompact(value: unknown, max = 140): string {
  let s: string;
  if (typeof value === "string") s = value;
  else {
    try {
      s = JSON.stringify(value) ?? String(value);
    } catch {
      s = String(value);
    }
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A value cell: short values inline, long ones behind an expander. */
export function valueCell(value: unknown): Node {
  const compact = fmtCompact(value, 120);
  let full: string;
  try {
    full = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    full = String(value);
  }
  if (full.length <= 120 && !full.includes("\n")) {
    return h("code", null, compact);
  }
  return collapse(h("code", null, compact), jsonBlock(value));
}

export function relTime(iso: string | undefined | null): HTMLElement {
  if (!iso) return h("span", null, "—");
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return h("span", null, String(iso));
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  const label =
    sec < 60
      ? `${sec}s ago`
      : sec < 3600
        ? `${Math.floor(sec / 60)}m ago`
        : sec < 86400
          ? `${Math.floor(sec / 3600)}h ago`
          : sec < 86400 * 365
            ? `${Math.floor(sec / 86400)}d ago`
            : `${Math.floor(sec / (86400 * 365))}y ago`;
  return h("span", { title: iso }, label);
}
