import { afterEach, describe, expect, it } from "vitest";
import { ApiTokenStore } from "../../src/auth/apiTokenStore.js";
import {
  CredentialStoreUnreadableError,
  TokenStore,
  type StoredToken,
} from "../../src/auth/tokenStore.js";
import { encrypt } from "../../src/auth/encryption.js";
import { makeRedis } from "../helpers/redis.js";

const KEY = Buffer.alloc(32, 7);
const ACCOUNT = "acct-1";

const oauthToken = (accessToken: string, refreshToken = `rt-${accessToken}`): StoredToken => ({
  access_token: accessToken,
  refresh_token: refreshToken,
  expires_at: Date.now() + 60_000,
  account_id: ACCOUNT,
  name: "Test User",
  email: "test@example.com",
  accessible_cloud_ids: ["cloud-1"],
  primary_cloud_id: "cloud-1",
});

const clients: ReturnType<typeof makeRedis>[] = [];
const redisForTest = () => {
  const redis = makeRedis();
  clients.push(redis);
  return redis;
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((redis) => redis.quit()));
});

describe("TokenStore fail-closed decoding", () => {
  it("preserves an undecryptable OAuth entry and surfaces a sanitized distinct error", async () => {
    const redis = redisForTest();
    const raw = "not-valid-ciphertext-secret-value";
    await redis.set(`token:${ACCOUNT}`, raw);

    const store = new TokenStore(redis, KEY);
    await expect(store.get(ACCOUNT)).rejects.toMatchObject({
      name: "CredentialStoreUnreadableError",
      code: "UNEXPECTED_ERROR",
      details: { reason: "CREDENTIAL_STORE_UNREADABLE", credential: "oauth" },
    });
    await expect(store.get(ACCOUNT)).rejects.not.toThrow(raw);
    expect(await redis.get(`token:${ACCOUNT}`)).toBe(raw);
  });

  it("preserves a decryptable entry whose JSON is invalid", async () => {
    const redis = redisForTest();
    const raw = encrypt("{not-json", KEY);
    await redis.set(`token:${ACCOUNT}`, raw);

    await expect(new TokenStore(redis, KEY).get(ACCOUNT)).rejects.toBeInstanceOf(
      CredentialStoreUnreadableError,
    );
    expect(await redis.get(`token:${ACCOUNT}`)).toBe(raw);
  });

  it("preserves an unreadable API-token entry with the same fail-closed contract", async () => {
    const redis = redisForTest();
    const raw = encrypt("[]", KEY);
    await redis.set(`apitoken:${ACCOUNT}`, raw);

    await expect(new ApiTokenStore(redis, KEY).get(ACCOUNT)).rejects.toMatchObject({
      name: "CredentialStoreUnreadableError",
      details: { reason: "CREDENTIAL_STORE_UNREADABLE", credential: "api_token" },
    });
    expect(await redis.get(`apitoken:${ACCOUNT}`)).toBe(raw);
  });
});

describe("TokenStore compare-and-swap writes", () => {
  it("updates only the exact snapshot", async () => {
    const redis = redisForTest();
    const store = new TokenStore(redis, KEY);
    await store.put(oauthToken("old"));
    const snapshot = await store.getSnapshot(ACCOUNT);
    expect(snapshot).not.toBeNull();

    expect(await store.putIfUnchanged(oauthToken("refreshed"), snapshot!.version)).toBe(true);
    expect((await store.get(ACCOUNT))?.access_token).toBe("refreshed");
  });

  it("does not overwrite or delete a newer callback/login credential", async () => {
    const redis = redisForTest();
    const store = new TokenStore(redis, KEY);
    await store.put(oauthToken("old"));
    const snapshot = await store.getSnapshot(ACCOUNT);
    expect(snapshot).not.toBeNull();

    await store.put(oauthToken("new-login"));

    expect(await store.putIfUnchanged(oauthToken("stale-refresh"), snapshot!.version)).toBe(false);
    expect(await store.deleteIfUnchanged(ACCOUNT, snapshot!.version)).toBe(false);
    expect((await store.get(ACCOUNT))?.access_token).toBe("new-login");
  });
});
