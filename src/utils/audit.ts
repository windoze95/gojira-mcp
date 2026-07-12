import { appendFileSync, openSync, closeSync } from "node:fs";
import axios from "axios";
import { createSocket } from "node:dgram";
import type { AppConfig } from "../config.js";
import { logger } from "./logger.js";

export interface AuditEvent {
  ts: string;
  level: "audit";
  event: "tool_call";
  actor: { account_id: string; name: string | null; email: string | null };
  tool: string;
  group: string;
  cloud_id: string | null;
  client_id: string | null;
  request: Record<string, unknown>;
  outcome: "success" | "failure" | "dry_run";
  error_code: string | null;
  duration_ms: number;
  operation_id: string | null;
  /** Only populated for org-admin operations. */
  org_id?: string | null;
}

export class AuditSink {
  constructor(
    private readonly mainTarget: string,
    private readonly orgAdminTarget: string,
  ) {}

  emit(event: AuditEvent, opts: { orgAdmin?: boolean } = {}): void {
    const target = opts.orgAdmin ? this.orgAdminTarget : this.mainTarget;
    void this.write(target, event);
  }

  private async write(target: string, event: AuditEvent): Promise<void> {
    try {
      if (target === "stdout") {
        // eslint-disable-next-line no-console
        process.stdout.write(`${JSON.stringify(event)}\n`);
        return;
      }
      if (target.startsWith("file:")) {
        const path = target.slice("file:".length);
        try {
          appendFileSync(path, `${JSON.stringify(event)}\n`);
        } catch (err) {
          // If the path is new and the directory doesn't exist, fall back to stdout.
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), path },
            "audit file write failed; falling back to stdout",
          );
          process.stdout.write(`${JSON.stringify(event)}\n`);
        }
        return;
      }
      if (target.startsWith("http://") || target.startsWith("https://")) {
        try {
          await axios.post(target, event, { timeout: 5000 });
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "audit HTTP write failed",
          );
        }
        return;
      }
      if (target.startsWith("syslog:")) {
        // Best-effort syslog over UDP (RFC 3164 — basic facility/severity prefix).
        // Target grammar: `syslog:<facility>` or `syslog:<facility>@<host>:<port>`
        // (defaults 127.0.0.1:514). The container's collector is rarely on
        // loopback, so the host must be configurable.
        const spec = target.slice("syslog:".length);
        const [facility, hostPort] = spec.split("@", 2);
        let host = "127.0.0.1";
        let port = 514;
        if (hostPort) {
          const idx = hostPort.lastIndexOf(":");
          if (idx > -1) {
            host = hostPort.slice(0, idx) || host;
            const p = Number(hostPort.slice(idx + 1));
            if (Number.isFinite(p) && p > 0) port = p;
          } else {
            host = hostPort;
          }
        }
        const facCode = facilityCode(facility || "user");
        const pri = facCode * 8 + 6; // severity 6 (informational)
        // Encode as a Buffer and send its byte length — `msg.length` counts UTF-16
        // code units and truncates any multi-byte content.
        const buf = Buffer.from(
          `<${pri}>${new Date().toISOString()} gojira-mcp ${JSON.stringify(event)}`,
          "utf8",
        );
        const sock = createSocket("udp4");
        sock.send(buf, 0, buf.length, port, host, () => sock.close());
        return;
      }
      // Unknown scheme — log and drop.
      logger.warn({ target }, "Unknown audit target scheme; event dropped");
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Audit emit failed",
      );
    }
  }
}

export function buildAuditSink(cfg: AppConfig): AuditSink {
  if (cfg.audit.mainTarget.startsWith("file:")) {
    // Pre-open and immediately close to surface permission issues at startup.
    try {
      const path = cfg.audit.mainTarget.slice("file:".length);
      const fd = openSync(path, "a");
      closeSync(fd);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Audit file is not writable at startup",
      );
    }
  }
  return new AuditSink(cfg.audit.mainTarget, cfg.audit.orgAdminTarget);
}

function facilityCode(name: string): number {
  const map: Record<string, number> = {
    kern: 0,
    user: 1,
    mail: 2,
    daemon: 3,
    auth: 4,
    syslog: 5,
    lpr: 6,
    news: 7,
    uucp: 8,
    cron: 9,
    authpriv: 10,
    ftp: 11,
    local0: 16,
    local1: 17,
    local2: 18,
    local3: 19,
    local4: 20,
    local5: 21,
    local6: 22,
    local7: 23,
  };
  return map[name.toLowerCase()] ?? 1;
}
