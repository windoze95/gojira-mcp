import { randomBytes, randomUUID } from "node:crypto";
import type { RedisType } from "../redis/client.js";
import type {
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const CLIENT_TTL_SECONDS = 90 * 24 * 60 * 60; // 90d

export class RedisClientsStore {
  constructor(private readonly redis: RedisType) {}

  private k(id: string): string {
    return `oauth_client:${id}`;
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const key = this.k(clientId);
    const v = await this.redis.get(key);
    if (!v) return undefined;
    const client = JSON.parse(v) as OAuthClientInformationFull;

    // Public DCR clients have no secret whose fixed expiry must be preserved.
    // Keep an actively used registration alive so long-running Codex clients do
    // not have to register again every 90 days. Confidential registrations stay
    // fixed-lifetime because extending their Redis TTL past
    // client_secret_expires_at would leave an unusable record behind and would
    // silently weaken the secret-expiry contract.
    if (client.token_endpoint_auth_method === "none") {
      await this.redis.expire(key, CLIENT_TTL_SECONDS);
    }

    return client;
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    const clientId = randomUUID();
    const issued = Math.floor(Date.now() / 1000);
    // Honor the client's declared auth method. Public clients register with
    // `token_endpoint_auth_method: "none"` and authenticate via PKCE only —
    // forcing a client_secret on them breaks their token exchange (they never
    // send one, and the SDK then rejects the request as a client mismatch).
    const isPublic = client.token_endpoint_auth_method === "none";
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: issued,
      ...(isPublic
        ? {}
        : {
            client_secret: randomBytes(32).toString("hex"),
            client_secret_expires_at: issued + CLIENT_TTL_SECONDS,
          }),
    };
    await this.redis.set(this.k(clientId), JSON.stringify(full), "EX", CLIENT_TTL_SECONDS);
    return full;
  }
}
