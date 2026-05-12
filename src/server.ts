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
}

export function createApp(config: AppConfig, redis: RedisType): Express {
  const app = express();

  // 1. helmet — secure default headers.
  app.use(helmet());

  // 2. CORS — allowlist driven by ALLOWED_ORIGINS, supports '*'.
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (config.allowedOrigins.includes("*")) return cb(null, true);
        if (config.allowedOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      credentials: true,
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

    const entry: SessionEntry = { transport, server, createdAt: Date.now() };
    return entry;
  }

  // 8. /mcp transport handlers — bearer-protected.
  const bearer = requireBearerAuth({ verifier: oauthProvider });

  app.post("/mcp", bearer, async (req, res, next) => {
    try {
      const sid = lookupSessionId(req);
      if (sid && sessions.has(sid)) {
        const entry = sessions.get(sid)!;
        await entry.transport.handleRequest(req, res, req.body);
        return;
      }
      // New session
      const entry = await createMcpSession(req, res);
      await entry.transport.handleRequest(req, res, req.body);
    } catch (err) {
      next(err);
    }
  });

  app.get("/mcp", bearer, async (req, res, next) => {
    try {
      const sid = lookupSessionId(req);
      if (!sid || !sessions.has(sid)) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      await sessions.get(sid)!.transport.handleRequest(req, res);
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
