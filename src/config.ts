import { z } from "zod";
import { ALL_PERMISSION_GROUPS } from "./tools/permissionGroups.js";

const scopeList = z
  .string()
  .transform((s) =>
    s
      .split(/\s+/)
      .map((x) => x.trim())
      .filter(Boolean),
  )
  .refine(
    (arr) => arr.length > 0 && arr.includes("offline_access"),
    "ATLASSIAN_OAUTH_SCOPES must be non-empty and include 'offline_access'",
  );

const auditTarget = z.string().refine(
  (v) => v === "stdout" || /^file:.+/.test(v) || /^https?:\/\/.+/.test(v) || /^syslog:.+/.test(v),
  "audit target must be 'stdout', 'file:/path', 'http(s)://...', or 'syslog:facility'",
);

const truthy = z
  .string()
  .transform((v) => v.toLowerCase() === "true" || v === "1" || v.toLowerCase() === "yes");

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),

    MCP_PORT: z.coerce.number().int().positive().default(8081),
    MCP_SERVER_URL: z
      .string()
      .url()
      .optional()
      .transform((v) => v?.replace(/\/+$/, "")),

    ALLOWED_ORIGINS: z.string().min(1, "ALLOWED_ORIGINS is required (use '*' for any origin)"),

    REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

    TOKEN_ENCRYPTION_KEY: z
      .string()
      .min(1, "TOKEN_ENCRYPTION_KEY is required")
      .refine((v) => {
        try {
          return Buffer.from(v, "base64").length === 32;
        } catch {
          return false;
        }
      }, "TOKEN_ENCRYPTION_KEY must base64-decode to exactly 32 bytes"),

    RATE_LIMIT_PER_USER: z.coerce.number().int().positive().default(60),

    TLS_CERT_PATH: z.string().optional(),
    TLS_KEY_PATH: z.string().optional(),

    // Atlassian OAuth
    ATLASSIAN_OAUTH_CLIENT_ID: z.string().min(1),
    ATLASSIAN_OAUTH_CLIENT_SECRET: z.string().min(1),
    ATLASSIAN_CALLBACK_URI: z.string().url().optional(),
    ATLASSIAN_OAUTH_SCOPES: scopeList,
    ATLASSIAN_PINNED_CLOUD_ID: z.string().optional(),

    // Org-admin gate (admin.atlassian.com)
    GOJIRA_ENABLE_ORG_ADMIN: truthy.default("false"),
    GOJIRA_ORG_ADMIN_TOKEN: z.string().optional(),
    GOJIRA_ORG_ID: z.string().optional(),
    // Explicit allowlist of Atlassian accountIds permitted to invoke admin_org
    // tools. There is no reliable public endpoint to enumerate an org's admins,
    // so caller-verification is operator-declared: only accounts listed here
    // pass the org-admin gate. Empty (with org admin enabled) fails closed.
    GOJIRA_ORG_ADMIN_ACCOUNT_IDS: z
      .string()
      .optional()
      .transform((v) =>
        (v ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),

    // Audit
    GOJIRA_AUDIT_LOG_TARGET: auditTarget.default("stdout"),
    GOJIRA_ORG_ADMIN_AUDIT_LOG_TARGET: auditTarget.optional(),

    // Operation journal
    GOJIRA_OPERATION_JOURNAL_TTL_DAYS: z.coerce.number().int().positive().default(30),

    // Refresh reuse alerting
    GOJIRA_REFRESH_REUSE_ALERT_WEBHOOK: z.string().url().optional(),

    // Usage metrics read endpoint (GET /metrics/usage); disabled when unset.
    GOJIRA_METRICS_TOKEN: z
      .string()
      .min(16, "GOJIRA_METRICS_TOKEN must be at least 16 characters")
      .optional(),

    // Atlassian NearLimit tuning
    GOJIRA_NEAR_LIMIT_EXTRA_DEDUCT: z.coerce.number().int().nonnegative().default(5),

    // Operator allowlist: comma-separated permission groups this deployment
    // will register. Required, no implicit default — the env var is the
    // explicit declaration of the deployment's tool surface.
    GOJIRA_ENABLED_GROUPS: z
      .string()
      .min(1, "GOJIRA_ENABLED_GROUPS is required (comma-separated permission groups)")
      .transform((v) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
      .superRefine((arr, ctx) => {
        if (arr.length === 0) {
          ctx.addIssue({
            code: "custom",
            message: "GOJIRA_ENABLED_GROUPS must list at least one permission group",
          });
          return;
        }
        const known = new Set<string>(ALL_PERMISSION_GROUPS);
        const unknown = arr.filter((g) => !known.has(g));
        if (unknown.length > 0) {
          ctx.addIssue({
            code: "custom",
            message: `GOJIRA_ENABLED_GROUPS contains unknown groups: ${unknown.join(
              ", ",
            )}. Valid groups: ${ALL_PERMISSION_GROUPS.join(", ")}`,
          });
        }
      }),
  })
  .refine(
    (v) => (v.TLS_CERT_PATH && v.TLS_KEY_PATH) || (!v.TLS_CERT_PATH && !v.TLS_KEY_PATH),
    { message: "TLS_CERT_PATH and TLS_KEY_PATH must be set together or not at all" },
  )
  .refine(
    (v) =>
      !v.GOJIRA_ENABLE_ORG_ADMIN ||
      (v.GOJIRA_ORG_ADMIN_TOKEN && v.GOJIRA_ORG_ADMIN_TOKEN.length > 0 && v.GOJIRA_ORG_ID),
    {
      message:
        "GOJIRA_ORG_ADMIN_TOKEN and GOJIRA_ORG_ID are required when GOJIRA_ENABLE_ORG_ADMIN=true",
    },
  )
  .refine(
    (v) => !v.GOJIRA_ENABLE_ORG_ADMIN || v.GOJIRA_ORG_ADMIN_ACCOUNT_IDS.length > 0,
    {
      message:
        "GOJIRA_ORG_ADMIN_ACCOUNT_IDS must list at least one Atlassian accountId when " +
        "GOJIRA_ENABLE_ORG_ADMIN=true — org-admin caller verification is operator-declared " +
        "(there is no public endpoint to enumerate org admins). Fails closed otherwise.",
    },
  )
  .refine((v) => v.NODE_ENV !== "production" || !!v.MCP_SERVER_URL, {
    message:
      "MCP_SERVER_URL must be set explicitly when NODE_ENV=production — otherwise OAuth " +
      "callback/issuer URLs silently point at http://localhost, breaking the consent flow.",
  });

export type AppConfig = Readonly<{
  nodeEnv: "development" | "test" | "production";
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  mcpPort: number;
  mcpServerUrl: string;
  allowedOrigins: string[];
  redisUrl: string;
  tokenEncryptionKey: Buffer;
  rateLimitPerUser: number;
  tls: { certPath: string; keyPath: string } | null;
  atlassian: {
    clientId: string;
    clientSecret: string;
    callbackUri: string;
    /** Atlassian OAuth scopes this deployment requests upstream at /authorize. */
    scopes: string[];
    pinnedCloudId: string | null;
  };
  orgAdmin: {
    enabled: boolean;
    token: string | null;
    orgId: string | null;
    /** Operator-declared allowlist of accountIds permitted to use admin_org tools. */
    adminAccountIds: string[];
  };
  audit: {
    mainTarget: string;
    orgAdminTarget: string;
  };
  journal: { ttlDays: number };
  /** Bearer token for GET /metrics/usage; the route is disabled when null. */
  metricsToken: string | null;
  refreshReuseAlertWebhook: string | null;
  nearLimitExtraDeduct: number;
  /**
   * Permission groups this deployment registers. Operator allowlist —
   * the only runtime knob for surface size, alongside `GOJIRA_ENABLE_ORG_ADMIN`.
   */
  enabledGroups: string[];
}>;

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  // Treat empty-string env vars as unset. Copying `.env.example` leaves several
  // optional keys as `KEY=`, which would otherwise fail `.url()`/format refinements
  // instead of falling through to their defaults.
  const cleanedEnv: Record<string, string | undefined> = {};
  for (const [k, val] of Object.entries(process.env)) {
    cleanedEnv[k] = val === "" ? undefined : val;
  }
  const parsed = ConfigSchema.safeParse(cleanedEnv);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.error(`Configuration error:\n${issues}`);
    process.exit(1);
  }
  const v = parsed.data;
  const mcpServerUrl = v.MCP_SERVER_URL ?? `http://localhost:${v.MCP_PORT}`;
  const callbackUri = v.ATLASSIAN_CALLBACK_URI ?? `${mcpServerUrl}/oauth/atlassian-callback`;

  cached = Object.freeze({
    nodeEnv: v.NODE_ENV,
    logLevel: v.LOG_LEVEL,
    mcpPort: v.MCP_PORT,
    mcpServerUrl,
    allowedOrigins: v.ALLOWED_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    redisUrl: v.REDIS_URL,
    tokenEncryptionKey: Buffer.from(v.TOKEN_ENCRYPTION_KEY, "base64"),
    rateLimitPerUser: v.RATE_LIMIT_PER_USER,
    tls:
      v.TLS_CERT_PATH && v.TLS_KEY_PATH
        ? { certPath: v.TLS_CERT_PATH, keyPath: v.TLS_KEY_PATH }
        : null,
    atlassian: {
      clientId: v.ATLASSIAN_OAUTH_CLIENT_ID,
      clientSecret: v.ATLASSIAN_OAUTH_CLIENT_SECRET,
      callbackUri,
      scopes: v.ATLASSIAN_OAUTH_SCOPES,
      pinnedCloudId: v.ATLASSIAN_PINNED_CLOUD_ID ?? null,
    },
    orgAdmin: {
      enabled: v.GOJIRA_ENABLE_ORG_ADMIN,
      token: v.GOJIRA_ORG_ADMIN_TOKEN ?? null,
      orgId: v.GOJIRA_ORG_ID ?? null,
      adminAccountIds: v.GOJIRA_ORG_ADMIN_ACCOUNT_IDS,
    },
    audit: {
      mainTarget: v.GOJIRA_AUDIT_LOG_TARGET,
      orgAdminTarget: v.GOJIRA_ORG_ADMIN_AUDIT_LOG_TARGET ?? v.GOJIRA_AUDIT_LOG_TARGET,
    },
    journal: { ttlDays: v.GOJIRA_OPERATION_JOURNAL_TTL_DAYS },
    metricsToken: v.GOJIRA_METRICS_TOKEN ?? null,
    refreshReuseAlertWebhook: v.GOJIRA_REFRESH_REUSE_ALERT_WEBHOOK ?? null,
    nearLimitExtraDeduct: v.GOJIRA_NEAR_LIMIT_EXTRA_DEDUCT,
    enabledGroups: v.GOJIRA_ENABLED_GROUPS,
  });
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}
