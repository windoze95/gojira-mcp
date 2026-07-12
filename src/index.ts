import "dotenv/config";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import { loadConfig } from "./config.js";
import { createRedisClient } from "./redis/client.js";
import { createApp } from "./server.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info(
    {
      env: config.nodeEnv,
      port: config.mcpPort,
      mcp_server_url: config.mcpServerUrl,
      pinned_cloud_id: config.atlassian.pinnedCloudId,
      enabled_groups: config.enabledGroups,
      org_admin_enabled: config.orgAdmin.enabled,
    },
    "gojira-mcp starting",
  );

  const redis = createRedisClient(config.redisUrl);
  const app = createApp(config, redis);

  const server = config.tls
    ? createHttpsServer(
        {
          cert: readFileSync(config.tls.certPath),
          key: readFileSync(config.tls.keyPath),
        },
        app,
      )
    : createHttpServer(app);

  server.listen(config.mcpPort, () => {
    const scheme = config.tls ? "https" : "http";
    logger.info(
      {
        listening: `${scheme}://0.0.0.0:${config.mcpPort}`,
        health: `${config.mcpServerUrl}/health`,
        mcp: `${config.mcpServerUrl}/mcp`,
        oauth_discovery: `${config.mcpServerUrl}/.well-known/oauth-authorization-server`,
      },
      "gojira-mcp listening",
    );
  });

  let shuttingDown = false;
  const SHUTDOWN_HARD_TIMEOUT_MS = 15_000;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown initiated");

    // Backstop: never hang forever waiting on a stuck connection or stream.
    const hardTimer = setTimeout(() => {
      logger.warn("graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, SHUTDOWN_HARD_TIMEOUT_MS);
    hardTimer.unref?.();

    // 1. Stop accepting new connections. server.close() only resolves once every
    //    live connection has ended, and long-lived MCP/SSE streams keep theirs
    //    open indefinitely — so start the close now and await it in step 3,
    //    AFTER the transports are gone. Awaiting it here deadlocks.
    const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));

    // 2. Close MCP sessions/transports so in-flight streams and their
    //    journal/audit writes finish rather than being killed mid-write.
    try {
      const gojiraShutdown = app.locals.gojiraShutdown as undefined | (() => Promise<void>);
      if (gojiraShutdown) await gojiraShutdown();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "session shutdown failed");
    }

    // 3. The streams are torn down; drop idle keep-alive sockets so the
    //    listener can actually finish closing.
    server.closeIdleConnections();
    await httpClosed;
    logger.info("HTTP listener closed");

    // 4. Close Redis last.
    try {
      await redis.quit();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "redis.quit failed");
    }

    clearTimeout(hardTimer);
    logger.info("shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }, "fatal error during startup");
  process.exit(1);
});
