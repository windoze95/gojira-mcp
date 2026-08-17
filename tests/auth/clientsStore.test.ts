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
    const redis = makeRedis();
    const store = new RedisClientsStore(redis);
    const created = await store.registerClient({
      redirect_uris: ["http://localhost/cb"],
      token_endpoint_auth_method: "none",
    } as never);
    const got = await store.getClient(created.client_id);
    expect(got?.client_id).toBe(created.client_id);
    expect(got?.client_secret).toBeUndefined();
  });

  it("slides the 90-day TTL when an active public client is read", async () => {
    const redis = makeRedis();
    const store = new RedisClientsStore(redis);
    const created = await store.registerClient({
      redirect_uris: ["http://localhost/cb"],
      token_endpoint_auth_method: "none",
    } as never);
    const key = `oauth_client:${created.client_id}`;

    await redis.expire(key, 10);
    await store.getClient(created.client_id);

    expect(await redis.ttl(key)).toBeGreaterThan(89 * 24 * 60 * 60);
  });

  it("does not extend a confidential client's TTL or secret expiry", async () => {
    const redis = makeRedis();
    const store = new RedisClientsStore(redis);
    const created = await store.registerClient({
      redirect_uris: ["http://localhost/cb"],
      token_endpoint_auth_method: "client_secret_post",
    } as never);
    const key = `oauth_client:${created.client_id}`;
    const secretExpiresAt = created.client_secret_expires_at;

    await redis.expire(key, 10);
    const got = await store.getClient(created.client_id);
    const ttl = await redis.ttl(key);

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10);
    expect(got?.client_secret_expires_at).toBe(secretExpiresAt);
  });
});
