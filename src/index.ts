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

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutdown initiated");
    server.close(() => logger.info("HTTP listener closed"));
    try {
      await redis.quit();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "redis.quit failed");
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }, "fatal error during startup");
  process.exit(1);
});
