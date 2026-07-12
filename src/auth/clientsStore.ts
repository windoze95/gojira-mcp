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
    const v = await this.redis.get(this.k(clientId));
    if (!v) return undefined;
    return JSON.parse(v) as OAuthClientInformationFull;
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
