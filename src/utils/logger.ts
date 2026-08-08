import { createRequire } from "node:module";
import os from "node:os";
import pino from "pino";

const logLevel = (process.env.LOG_LEVEL ?? "info") as
  | "fatal"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace";
const isDev = process.env.NODE_ENV !== "production";
// Read from env (not loadConfig) — the logger initializes at import time,
// before config validation runs. Only bound when set, so single-instance
// deployments keep their existing log shape.
const instanceName = process.env.GOJIRA_INSTANCE_NAME;

// pino-pretty is a devDependency and is pruned from the production image. Only
// use it when it's actually resolvable, otherwise pino throws at startup
// ("unable to determine transport target") and the process crash-loops — which
// is exactly what happens if NODE_ENV is left at the dev default in a prod
// container. Fall back to structured JSON logging when it's absent.
function prettyAvailable(): boolean {
  if (!isDev) return false;
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

export const logger = pino({
  level: logLevel,
  ...(instanceName
    ? { base: { pid: process.pid, hostname: os.hostname(), instance: instanceName } }
    : {}),
  redact: {
    paths: [
      "*.token",
      "*.access_token",
      "*.refresh_token",
      "*.client_secret",
      "*.password",
      "req.query.token",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    censor: "[REDACTED]",
  },
  ...(prettyAvailable()
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", singleLine: false },
        },
      }
    : {}),
});

export type Logger = typeof logger;
