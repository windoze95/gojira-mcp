import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { allTools } from "../src/tools/defs/index.js";
import type { AnyToolDef } from "../src/tools/defs/defineTool.js";
import { ALL_PERMISSION_GROUPS } from "../src/tools/permissionGroups.js";
import { allLegacyAliases } from "../src/operations/legacyAliases.js";

const OUT_PATH = "docs/tools/catalog.md";

function describeZod(schema: z.ZodTypeAny, depth = 0): string {
  const indent = "  ".repeat(depth);
  const def = (schema as unknown as { _def?: { typeName?: string; description?: string } })._def;
  const typeName = def?.typeName ?? "unknown";
  const description = (schema.description ?? def?.description ?? "").trim();
  const optional = schema.isOptional?.() ?? false;
  const nullable = schema.isNullable?.() ?? false;

  let type = "unknown";
  let inner = "";

  switch (typeName) {
    case "ZodString":
      type = "string";
      break;
    case "ZodNumber":
      type = "number";
      break;
    case "ZodBoolean":
      type = "boolean";
      break;
    case "ZodEnum": {
      const values = (schema as unknown as { options?: readonly string[] }).options ?? [];
      type = `enum(${values.map((v) => JSON.stringify(v)).join(" | ")})`;
      break;
    }
    case "ZodArray": {
      const el = (schema as unknown as { element: z.ZodTypeAny }).element;
      type = `array<${describeZod(el, depth + 1).split("\n")[0]}>`;
      break;
    }
    case "ZodObject": {
      type = "object";
      const shape = (schema as unknown as z.ZodObject<z.ZodRawShape>).shape;
      const lines: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        lines.push(`${indent}  - \`${k}\`: ${describeZod(v, depth + 1)}`);
      }
      inner = "\n" + lines.join("\n");
      break;
    }
    case "ZodRecord":
      type = "record<string, unknown>";
      break;
    case "ZodOptional": {
      const wrapped = (schema as unknown as { unwrap: () => z.ZodTypeAny }).unwrap();
      return describeZod(wrapped, depth) + (description ? "" : "");
    }
    case "ZodDefault": {
      const wrapped = (schema as unknown as { _def: { innerType: z.ZodTypeAny; defaultValue: () => unknown } })._def;
      const dv = wrapped.defaultValue();
      const inside = describeZod(wrapped.innerType, depth);
      return `${inside} (default: ${JSON.stringify(dv)})`;
    }
    case "ZodNullable": {
      const wrapped = (schema as unknown as { unwrap: () => z.ZodTypeAny }).unwrap();
      return `${describeZod(wrapped, depth)} | null`;
    }
    case "ZodLiteral": {
      const v = (schema as unknown as { value: unknown }).value;
      type = `literal(${JSON.stringify(v)})`;
      break;
    }
    case "ZodUnion": {
      const opts = (schema as unknown as { options: z.ZodTypeAny[] }).options;
      type = opts.map((o) => describeZod(o, depth + 1).split("\n")[0]).join(" | ");
      break;
    }
    case "ZodUnknown":
    case "ZodAny":
      type = "unknown";
      break;
  }

  const suffix: string[] = [];
  if (optional) suffix.push("optional");
  if (nullable) suffix.push("nullable");
  const suffixStr = suffix.length > 0 ? ` _(${suffix.join(", ")})_` : "";
  const descStr = description ? ` — ${description}` : "";
  return `${type}${suffixStr}${descStr}${inner}`;
}

function renderTool(t: AnyToolDef): string {
  const lines: string[] = [];
  lines.push(`### \`${t.name}\``);
  lines.push("");
  lines.push(t.description);
  lines.push("");
  lines.push(`- **Group:** \`${t.group}\``);
  lines.push(`- **Auth method:** ${t.authMethod}`);
  lines.push(`- **Destructive:** ${t.destructive ? "yes (commit-positive consent enforced)" : "no"}`);
  lines.push(`- **Requires cloudId:** ${t.needsCloudId ? "yes" : "no"}`);

  if (t.ops && t.ops.length > 0) {
    // Op-parameterized tool: the advertised schema is the flat merge; the
    // per-op sections below carry the real required-ness.
    lines.push(`- **Operations:** ${t.ops.length} (select with the required \`op\` field)`);
    if (t.destructive) {
      lines.push("- **Shared input:** `commit` _(boolean, optional)_ — commit-positive consent for every op");
    }
    lines.push("");
    for (const op of t.ops) {
      lines.push(`#### op: \`${op.op}\``);
      lines.push("");
      lines.push(op.description);
      lines.push("");
      lines.push(`- **Destructive:** ${op.destructive ? "yes" : "no"}`);
      if (op.legacyName) lines.push(`- **Replaces:** \`${op.legacyName}\``);
      const keys = Object.keys(op.inputShape);
      if (keys.length === 0) {
        lines.push("- **Input:** _(no parameters beyond `op`)_");
      } else {
        lines.push("- **Input:**");
        for (const k of keys) {
          lines.push(`  - \`${k}\`: ${describeZod(op.inputShape[k], 1)}`);
        }
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  const obj = t.inputSchema as unknown as z.ZodObject<z.ZodRawShape>;
  const shape = obj.shape;
  const keys = Object.keys(shape);
  if (keys.length === 0) {
    lines.push("- **Input:** _(no parameters)_");
  } else {
    lines.push("- **Input:**");
    for (const k of keys) {
      lines.push(`  - \`${k}\`: ${describeZod(shape[k], 1)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function main(): void {
  const tools = allTools();
  const byGroup = new Map<string, AnyToolDef[]>();
  for (const t of tools) {
    const arr = byGroup.get(t.group) ?? [];
    arr.push(t);
    byGroup.set(t.group, arr);
  }

  const sections: string[] = [];
  sections.push("# Tool catalog");
  sections.push("");
  sections.push(
    "_This file is generated by `npm run docs:tools` from the live `defineTool` registry. Do not edit by hand._",
  );
  sections.push("");
  // An op-parameterized tool counts each op; a plain tool counts as one
  // operation. The parenthetical appears only once any op tool exists, so the
  // pre-collapse catalog stays byte-identical.
  const anyOpTools = tools.some((t) => (t.ops?.length ?? 0) > 0);
  const operationCount = tools.reduce((n, t) => n + (t.ops?.length ?? 1), 0);
  sections.push(
    anyOpTools
      ? `Total tools registered: **${tools.length}** (**${operationCount}** operations).`
      : `Total tools registered: **${tools.length}**.`,
  );
  sections.push("");
  sections.push("## Tools by permission group");
  sections.push("");

  for (const g of ALL_PERMISSION_GROUPS) {
    const list = byGroup.get(g);
    if (!list || list.length === 0) continue;
    const groupOps = list.reduce((n, t) => n + (t.ops?.length ?? 1), 0);
    sections.push(
      anyOpTools
        ? `### \`${g}\` (${list.length} tools, ${groupOps} operations)`
        : `### \`${g}\` (${list.length} tools)`,
    );
    sections.push("");
    for (const t of list.sort((a, b) => a.name.localeCompare(b.name))) {
      sections.push(renderTool(t));
    }
    sections.push("---");
    sections.push("");
  }

  // Appendix: the pre-collapse → current name map, generated from the live
  // alias registry. Doubles as the audit/SIEM name-migration reference;
  // pre-collapse journal entries revert through these aliases for their
  // 30-day TTL. Living inside catalog.md puts it under the CI freshness gate.
  const aliases = [...allLegacyAliases()].sort((a, b) => a[0].localeCompare(b[0]));
  if (aliases.length > 0) {
    sections.push("## Legacy name map (pre-collapse → current)");
    sections.push("");
    sections.push(
      "_Generated from the live legacy-alias registry. Audit records and journal entries written before the " +
        "CRUD collapse carry the pre-collapse names on the left; they resolve to the current tool (and op) on the right._",
    );
    sections.push("");
    sections.push("| Pre-collapse tool | Now |");
    sections.push("|---|---|");
    for (const [oldName, alias] of aliases) {
      sections.push(`| \`${oldName}\` | \`${alias.tool}\`${alias.op ? ` · op \`${alias.op}\`` : ""} |`);
    }
    sections.push("");
  }

  const out = sections.join("\n");
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, out, "utf8");
  process.stdout.write(`Wrote ${OUT_PATH} (${tools.length} tools)\n`);
}

main();
