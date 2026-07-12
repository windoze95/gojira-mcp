import { describe, expect, it } from "vitest";
import { RedisClientsStore } from "../../src/auth/clientsStore.js";
import { makeRedis } from "../helpers/redis.js";

describe("RedisClientsStore — DCR auth-method handling", () => {
  it("issues a client_secret to confidential clients", async () => {
    const store = new RedisClientsStore(makeRedis());
    const client = await store.registerClient({
      redirect_uris: ["http://localhost/cb"],
      token_endpoint_auth_method: "client_secret_post",
    } as never);
    expect(client.client_secret).toBeTruthy();
    expect(client.client_secret_expires_at).toBeGreaterThan(0);
  });

  it("does NOT attach a client_secret to public clients (auth_method: none)", async () => {
    const store = new RedisClientsStore(makeRedis());
    const client = await store.registerClient({
      redirect_uris: ["http://localhost/cb"],
      token_endpoint_auth_method: "none",
    } as never);
    expect(client.client_secret).toBeUndefined();
    expect(client.client_secret_expires_at).toBeUndefined();
  });

  it("round-trips a stored client", async () => {
    const store = new RedisClientsStore(makeRedis());
    const created = await store.registerClient({
      redirect_uris: ["http://localhost/cb"],
      token_endpoint_auth_method: "none",
    } as never);
    const got = await store.getClient(created.client_id);
    expect(got?.client_id).toBe(created.client_id);
    expect(got?.client_secret).toBeUndefined();
  });
});
