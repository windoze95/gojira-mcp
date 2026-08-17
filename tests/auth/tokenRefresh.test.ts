import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config.js";
import { AuthExpiredError, UpstreamUnavailableError } from "../../src/middleware/errorHandler.js";
import { TokenRefresher } from "../../src/auth/tokenRefresh.js";
import { TokenStore, type StoredToken } from "../../src/auth/tokenStore.js";
import { makeRedis } from "../helpers/redis.js";

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock("../../src/atlassian/identity.js", () => ({
  refreshAtlassianTokens: mockRefresh,
}));

const KEY = Buffer.alloc(32, 4);
const ACCOUNT = "acct-refresh";

const config = {
  tokenEncryptionKey: KEY,
  atlassian: {
    clientId: "client-id",
    clientSecret: "client-secret",
  },
} as unknown as AppConfig;

const storedToken = (accessToken: string, refreshToken = `rt-${accessToken}`): StoredToken => ({
  access_token: accessToken,
  refresh_token: refreshToken,
  expires_at: Date.now() - 1_000,
  account_id: ACCOUNT,
  name: "Refresh User",
  email: "refresh@example.com",
  accessible_cloud_ids: ["cloud-1"],
  primary_cloud_id: "cloud-1",
});

const refreshedResponse = (accessToken: string) => ({
  access_token: accessToken,
  refresh_token: `rt-${accessToken}`,
  expires_in: 3_600,
  token_type: "Bearer",
});

let redis: ReturnType<typeof makeRedis>;
let store: TokenStore;
let refresher: TokenRefresher;

beforeEach(() => {
  vi.clearAllMocks();
  redis = makeRedis();
  store = new TokenStore(redis, KEY);
  refresher = new TokenRefresher(redis, config);
});

afterEach(async () => {
  vi.useRealTimers();
  await redis.quit();
});

describe("TokenRefresher compare-and-swap persistence", () => {
  it("persists a normal refresh response", async () => {
    await store.put(storedToken("old"));
    mockRefresh.mockResolvedValue(refreshedResponse("refreshed"));

    await expect(refresher.ensureFreshToken(ACCOUNT)).resolves.toMatchObject({
      access_token: "refreshed",
      refresh_token: "rt-refreshed",
    });
    expect((await store.get(ACCOUNT))?.access_token).toBe("refreshed");
  });

  it("adopts a newer callback/login instead of overwriting it after refresh succeeds", async () => {
    await store.put(storedToken("old"));
    const refresh = deferred<ReturnType<typeof refreshedResponse>>();
    mockRefresh.mockImplementation(() => refresh.promise);

    const inFlight = refresher.ensureFreshToken(ACCOUNT);
    await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledOnce());
    const newerLogin = {
      ...storedToken("new-login"),
      expires_at: Date.now() + 3_600_000,
    };
    await store.put(newerLogin);
    refresh.resolve(refreshedResponse("stale-refresh"));

    await expect(inFlight).resolves.toMatchObject({ access_token: "new-login" });
    expect((await store.get(ACCOUNT))?.access_token).toBe("new-login");
  });

  it("adopts a newer callback/login instead of deleting it after stale invalid_grant", async () => {
    await store.put(storedToken("old"));
    const refresh = deferred<never>();
    mockRefresh.mockImplementation(() => refresh.promise);

    const inFlight = refresher.ensureFreshToken(ACCOUNT);
    await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledOnce());
    const newerLogin = {
      ...storedToken("new-login"),
      expires_at: Date.now() + 3_600_000,
    };
    await store.put(newerLogin);
    refresh.reject(oauthError(400, "invalid_grant"));

    await expect(inFlight).resolves.toMatchObject({ access_token: "new-login" });
    expect((await store.get(ACCOUNT))?.access_token).toBe("new-login");
  });
});

describe("TokenRefresher invalid_grant classification", () => {
  it("deletes only the exact credential rejected with invalid_grant", async () => {
    await store.put(storedToken("old"));
    mockRefresh.mockRejectedValue(oauthError(400, "invalid_grant"));

    await expect(refresher.ensureFreshToken(ACCOUNT)).rejects.toBeInstanceOf(AuthExpiredError);
    expect(await redis.get(`token:${ACCOUNT}`)).toBeNull();
  });

  it.each([
    { status: 401, error: "invalid_client" },
    { status: 400, error: "invalid_request" },
    { status: 401, error: undefined },
  ])("preserves the credential for non-grant OAuth failure $status/$error", async ({ status, error }) => {
    await store.put(storedToken("old"));
    const before = await redis.get(`token:${ACCOUNT}`);
    mockRefresh.mockRejectedValue(oauthError(status, error));

    await expect(refresher.ensureFreshToken(ACCOUNT)).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    );
    expect(await redis.get(`token:${ACCOUNT}`)).toBe(before);
  });

  it("preserves the credential for a network failure", async () => {
    await store.put(storedToken("old"));
    const before = await redis.get(`token:${ACCOUNT}`);
    mockRefresh.mockRejectedValue(new Error("connect ETIMEDOUT sensitive-host"));

    await expect(refresher.ensureFreshToken(ACCOUNT)).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      details: {
        reason: "UPSTREAM_REFRESH_FAILED",
        status: null,
        oauth_error: "unclassified",
      },
    });
    expect(await redis.get(`token:${ACCOUNT}`)).toBe(before);
  });
});

describe("TokenRefresher lock contention", () => {
  it("reports a persistent lock as retryable rather than expired auth", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T12:00:00.000Z"));
    await store.put(storedToken("old"));
    await redis.set(`token_refresh_lock:${ACCOUNT}`, "another-refresher");

    const outcome = expect(refresher.ensureFreshToken(ACCOUNT)).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      details: { reason: "REFRESH_CONTENTION_TIMEOUT" },
    });
    // Let the initial Redis reads schedule the first contention poll, then
    // advance through the full bounded wait without sleeping in wall time.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_500);

    await outcome;
    expect(mockRefresh).not.toHaveBeenCalled();
    expect((await store.get(ACCOUNT))?.access_token).toBe("old");
  });
});

function oauthError(status: number, error?: string): unknown {
  return {
    response: {
      status,
      data: error
        ? { error, error_description: "sensitive upstream description" }
        : "transient response body",
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
