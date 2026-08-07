/** Parsing for gojira-mcp's `{success, result|error}` tool-result envelope. */

export interface ToolErrorInfo {
  code?: string;
  message?: string;
  details?: unknown;
  reference_id?: string;
}

export interface ToolEnvelope {
  success?: boolean;
  result?: unknown;
  error?: ToolErrorInfo;
}

export interface ParsedResult {
  isError: boolean;
  envelope: ToolEnvelope | null;
  /** envelope.result, for convenience. */
  result: unknown;
}

/** RFC 6902 ops as produced by the server's consent/jsonPatch.ts. */
export interface JsonPatchOp {
  op: "add" | "remove" | "replace";
  path: string;
  value?: unknown;
}

export interface DryRunPayload {
  dry_run: true;
  tool?: string;
  message?: string;
  target?: { kind?: string; id?: string; key?: string; name?: string } & Record<string, unknown>;
  diff?: { patch?: JsonPatchOp[]; before?: unknown; after?: unknown };
  commit_hint?: string;
  original?: { op_id?: string; tool?: string };
}

interface ToolResultLike {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Prefers structuredContent (always present for gojira-mcp results); falls
 * back to parsing the first text block for hosts that strip it.
 */
export function parseToolResult(params: unknown): ParsedResult {
  const p = (params ?? {}) as ToolResultLike;
  let envelope: ToolEnvelope | null = null;
  if (isRecord(p.structuredContent)) {
    envelope = p.structuredContent as ToolEnvelope;
  } else {
    const text = p.content?.find((c) => c?.type === "text" && typeof c.text === "string")?.text;
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (isRecord(parsed)) envelope = parsed as ToolEnvelope;
      } catch {
        envelope = null;
      }
    }
  }
  const isError = p.isError === true || envelope?.success === false;
  return { isError, envelope, result: envelope?.result };
}

export function isDryRun(result: unknown): result is DryRunPayload {
  return isRecord(result) && result.dry_run === true;
}
