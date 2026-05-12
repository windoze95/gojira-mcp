import { randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { AppConfig } from "../config.js";
import type { RedisType } from "../redis/client.js";
import { GojiraOAuthProvider } from "./oauthProvider.js";
import { TokenStore } from "./tokenStore.js";
import {
  exchangeCodeForAtlassianTokens,
  fetchAccessibleResources,
  fetchAtlassianMe,
} from "../atlassian/identity.js";
import { logger } from "../utils/logger.js";

/**
 * Mounts the Atlassian callback at /oauth/atlassian-callback.
 *
 * Spec §Atlassian Auth Specifics:
 *   1. Exchange code → upstream tokens.
 *   2. GET /me → account_id, name, email.
 *   3. GET /oauth/token/accessible-resources → cloudIds.
 *   4. If ATLASSIAN_PINNED_CLOUD_ID set, verify it appears in the list.
 *   5. Persist StoredToken.
 *   6. Issue our own auth code, 302 → client redirect.
 *
 * Error paths redirect back to the MCP client's redirect_uri with OAuth-spec
 * error params, never as JSON 500s.
 */
export function createOAuthCallbackRouter(
  config: AppConfig,
  redis: RedisType,
  provider: GojiraOAuthProvider,
): Router {
  const router = Router();
  const tokenStore = new TokenStore(redis, config.tokenEncryptionKey);

  router.get("/atlassian-callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const errorParam = typeof req.query.error === "string" ? req.query.error : null;
    const errorDescription =
      typeof req.query.error_description === "string" ? req.query.error_description : null;

    if (!state) {
      sendErrorPage(res, "invalid_request", "Missing state parameter");
      return;
    }
    const stateEntry = await provider.consumeAtlassianState(state);
    if (!stateEntry) {
      sendErrorPage(res, "invalid_request", "State expired or unknown");
      return;
    }
    const pending = await provider.getPendingAuth(stateEntry.pendingAuthId);
    if (!pending) {
      sendErrorPage(res, "invalid_request", "No matching authorization request");
      return;
    }

    const finishWithError = (oauthError: string, description: string) => {
      const url = new URL(pending.redirectUri);
      url.searchParams.set("error", oauthError);
      url.searchParams.set("error_description", description);
      if (pending.state) url.searchParams.set("state", pending.state);
      res.redirect(302, url.toString());
    };

    if (errorParam) {
      logger.warn(
        { errorParam, errorDescription, clientId: pending.clientId },
        "Atlassian returned an error to our callback",
      );
      await provider.deletePendingAuth(stateEntry.pendingAuthId);
      finishWithError(errorParam, errorDescription ?? "Atlassian denied the authorization");
      return;
    }
    if (!code) {
      await provider.deletePendingAuth(stateEntry.pendingAuthId);
      finishWithError("invalid_request", "Missing authorization code");
      return;
    }

    try {
      const tokens = await exchangeCodeForAtlassianTokens({
        clientId: config.atlassian.clientId,
        clientSecret: config.atlassian.clientSecret,
        code,
        redirectUri: config.atlassian.callbackUri,
      });

      const me = await fetchAtlassianMe(tokens.access_token);
      const resources = await fetchAccessibleResources(tokens.access_token);

      // D4 — site pinning.
      let primaryCloudId = resources[0]?.id ?? null;
      if (config.atlassian.pinnedCloudId) {
        const match = resources.find((r) => r.id === config.atlassian.pinnedCloudId);
        if (!match) {
          await provider.deletePendingAuth(stateEntry.pendingAuthId);
          finishWithError(
            "invalid_grant",
            "No access to the pinned cloud id on this instance",
          );
          return;
        }
        primaryCloudId = match.id;
      }

      // Persist upstream credentials. Expires_at in ms since epoch.
      const expiresAt = Date.now() + tokens.expires_in * 1000;
      await tokenStore.put({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? null,
        expires_at: expiresAt,
        account_id: me.account_id,
        name: me.name,
        email: me.email,
        accessible_cloud_ids: resources.map((r) => r.id),
        primary_cloud_id: primaryCloudId,
      });

      // Mint our own auth code.
      const mcpCode = randomBytes(32).toString("hex");
      await provider.storeAuthCode(mcpCode, {
        accountId: me.account_id,
        clientId: pending.clientId,
        codeChallenge: pending.codeChallenge,
        redirectUri: pending.redirectUri,
      });
      await provider.deletePendingAuth(stateEntry.pendingAuthId);

      const url = new URL(pending.redirectUri);
      url.searchParams.set("code", mcpCode);
      if (pending.state) url.searchParams.set("state", pending.state);
      res.redirect(302, url.toString());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "OAuth callback failed");
      await provider.deletePendingAuth(stateEntry.pendingAuthId);
      finishWithError("server_error", "Failed to complete authorization");
    }
  });

  return router;
}

function sendErrorPage(res: Response, error: string, description: string): void {
  res
    .status(400)
    .type("text/plain")
    .send(`OAuth error: ${error} — ${description}\n`);
}

// Re-exported so callers can reference the route path without typos.
export const ATLASSIAN_CALLBACK_PATH = "/atlassian-callback";

// Pass-through for tests.
export type { Request, Response };
