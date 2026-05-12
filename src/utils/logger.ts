import pino from "pino";

const logLevel = (process.env.LOG_LEVEL ?? "info") as
  | "fatal"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace";
const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: logLevel,
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
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", singleLine: false },
        },
      }
    : {}),
});

export type Logger = typeof logger;
