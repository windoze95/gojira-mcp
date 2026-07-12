import { randomUUID } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

import type { AppConfig } from "./config.js";
import type { RedisType } from "./redis/client.js";
import { GojiraOAuthProvider } from "./auth/oauthProvider.js";
import { createOAuthCallbackRouter } from "./auth/oauthCallback.js";
import { TokenRefresher } from "./auth/tokenRefresh.js";
import { ApiTokenStore } from "./auth/apiTokenStore.js";
import { OrgAdminVerifier } from "./auth/orgAdminVerifier.js";
import { RateLimiter } from "./middleware/rateLimiter.js";
import { OperationJournal } from "./operations/journal.js";
import { buildAuditSink } from "./utils/audit.js";
import { logger } from "./utils/logger.js";
import { registerSessionTools } from "./tools/registry.js";

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  createdAt: number;
  lastSeenAt: number;
}

/** Hard cap on concurrent MCP sessions; the oldest-idle is evicted past this. */
const MAX_SESSIONS = 10_000;
/** Sessions idle longer than this are swept and closed. */
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 60 * 1000;

export function createApp(config: AppConfig, redis: RedisType): Express {
  const app = express();

  // Trust the immediate reverse proxy (Caddy/TLS terminator) so req.ip reflects
  // the real client. Without this, express-rate-limit in the OAuth router keys
  // every request to the proxy's IP — one shared bucket that a single client
  // can exhaust, DoS-ing the auth flow for everyone.
  app.set("trust proxy", 1);

  // 1. helmet — secure default headers.
  app.use(helmet());

  // 2. CORS — allowlist driven by ALLOWED_ORIGINS, supports '*'.
  // Credentials are only enabled for an explicit origin allowlist: reflecting an
  // arbitrary origin *with* credentials is an unsafe combination. MCP auth is
  // bearer-based (Authorization header), so wildcard deployments don't need it.
  const allowCredentials = !config.allowedOrigins.includes("*");
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (config.allowedOrigins.includes("*")) return cb(null, true);
        if (config.allowedOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      credentials: allowCredentials,
      allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id", "MCP-Protocol-Version"],
      exposedHeaders: ["Mcp-Session-Id"],
    }),
  );

  // Body parsing for the OAuth routes and tool calls. The MCP transport
  // does its own parsing inside the SDK, but mcpAuthRouter expects JSON
  // payloads for /token / /revoke.
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  // 3. /health — unauthenticated.
  app.get("/health", async (_req, res) => {
    const start = Date.now();
    let redisOk = true;
    try {
      const pong = await redis.ping();
      redisOk = pong === "PONG";
    } catch {
      redisOk = false;
    }
    const status = redisOk ? 200 : 503;
    res.status(status).json({
      status: redisOk ? "ok" : "degraded",
      uptime: process.uptime(),
      redis: redisOk ? "ok" : "fail",
      duration_ms: Date.now() - start,
      timestamp: new Date().toISOString(),
    });
  });

  // 4. OAuth provider + auth router.
  const oauthProvider = new GojiraOAuthProvider({ redis, config });
  const issuerUrl = new URL(config.mcpServerUrl);
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl,
      resourceName: "gojira-mcp",
    }),
  );

  // 5. Atlassian callback at /oauth/atlassian-callback.
  app.use("/oauth", createOAuthCallbackRouter(config, redis, oauthProvider));

  // 6. Build shared dependencies once.
  const rateLimiter = new RateLimiter(redis, {
    capacity: config.rateLimitPerUser,
    windowSec: 60,
  });
  const audit = buildAuditSink(config);
  const journal = new OperationJournal(redis, config.journal.ttlDays);
  const tokenRefresher = new TokenRefresher(redis, config);
  const apiTokenStore = new ApiTokenStore(redis, config.tokenEncryptionKey);
  const orgAdminVerifier = new OrgAdminVerifier(redis, config);

  // 7. Session map.
  const sessions = new Map<string, SessionEntry>();

  function lookupSessionId(req: Request): string | null {
    const header = req.headers["mcp-session-id"];
    if (typeof header === "string" && header.length > 0) return header;
    return null;
  }

  async function createMcpSession(req: Request, _res: Response): Promise<SessionEntry> {
    const server = new McpServer({ name: "gojira-mcp", version: "0.1.0" });
    const auth = req.auth;
    const clientId = auth?.clientId ?? "unknown";
    registerSessionTools(
      server,
      {
        config,
        redis,
        rateLimiter,
        audit,
        journal,
        tokenRefresher,
        apiTokenStore,
        orgAdminVerifier,
      },
      { clientId },
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, entry);
        logger.info({ sessionId: id, clientId }, "MCP session initialized");
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
      logger.info({ sessionId: id }, "MCP session closed");
    };
    await server.connect(transport);

    // Evict the oldest-idle session if we're at capacity (bounds memory against
    // clients that open sessions and never DELETE them).
    if (sessions.size >= MAX_SESSIONS) {
      let oldestId: string | null = null;
      let oldestSeen = Infinity;
      for (const [id, e] of sessions) {
        if (e.lastSeenAt < oldestSeen) {
          oldestSeen = e.lastSeenAt;
          oldestId = id;
        }
      }
      if (oldestId) {
        const victim = sessions.get(oldestId);
        sessions.delete(oldestId);
        void victim?.transport.close().catch(() => undefined);
        logger.warn({ sessionId: oldestId }, "Session cap reached; evicted oldest-idle session");
      }
    }

    const entry: SessionEntry = { transport, server, createdAt: Date.now(), lastSeenAt: Date.now() };
    return entry;
  }

  // Periodically close sessions that have gone idle. unref() so it never keeps
  // the process alive on its own.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (now - entry.lastSeenAt > SESSION_IDLE_TTL_MS) {
        sessions.delete(id);
        void entry.transport.close().catch(() => undefined);
        logger.info({ sessionId: id }, "Swept idle MCP session");
      }
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  sweeper.unref?.();

  // Exposed for graceful shutdown (index.ts): stop the sweeper and close every
  // live transport so in-flight streams end cleanly.
  app.locals.gojiraShutdown = async (): Promise<void> => {
    clearInterval(sweeper);
    const entries = [...sessions.values()];
    sessions.clear();
    await Promise.allSettled(entries.map((e) => e.transport.close()));
  };

  // 8. /mcp transport handlers — bearer-protected.
  const bearer = requireBearerAuth({ verifier: oauthProvider });

  app.post("/mcp", bearer, async (req, res, next) => {
    try {
      const sid = lookupSessionId(req);
      if (sid) {
        // A session id was supplied. If we don't know it (stale/expired), reply
        // 404 so the client re-initializes — do NOT silently spin up a throwaway
        // session, which drops the client's state and misreports as a 400.
        const entry = sessions.get(sid);
        if (!entry) {
          res.status(404).json({ error: "session not found" });
          return;
        }
        entry.lastSeenAt = Date.now();
        await entry.transport.handleRequest(req, res, req.body);
        return;
      }
      // No session id → treat as an initialize request; create a new session.
      const entry = await createMcpSession(req, res);
      await entry.transport.handleRequest(req, res, req.body);
    } catch (err) {
      next(err);
    }
  });

  app.get("/mcp", bearer, async (req, res, next) => {
    try {
      const sid = lookupSessionId(req);
      const entry = sid ? sessions.get(sid) : undefined;
      if (!entry) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      entry.lastSeenAt = Date.now();
      await entry.transport.handleRequest(req, res);
    } catch (err) {
      next(err);
    }
  });

  app.delete("/mcp", bearer, async (req, res, next) => {
    try {
      const sid = lookupSessionId(req);
      if (!sid || !sessions.has(sid)) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const entry = sessions.get(sid)!;
      await entry.transport.close();
      sessions.delete(sid);
      res.status(200).json({ closed: true });
    } catch (err) {
      next(err);
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, stack: err instanceof Error ? err.stack : undefined }, "Unhandled express error");
    if (!res.headersSent) {
      res.status(500).json({ error: "internal_error", message });
    }
  });

  return app;
}
