import axios from "axios";
import type { RedisType } from "../redis/client.js";
import { logger } from "../utils/logger.js";

const TTL_SECONDS = 24 * 60 * 60; // 24h

/**
 * Discovers the Assets workspaceId for a given Atlassian site (cloudId).
 *
 * Spec: GET `/rest/servicedeskapi/assets/workspace` (per-cloudId).
 * Cached under `assets_workspace:<cloudId>`.
 *
 * The request runs via the site's OAuth tenant base; the caller supplies the
 * OAuth bearer because JSM scopes are required.
 */
export async function getAssetsWorkspaceId(
  redis: RedisType,
  cloudId: string,
  oauthBearer: string,
): Promise<string> {
  const cacheKey = `assets_workspace:${cloudId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/servicedeskapi/assets/workspace`;
  let resp;
  try {
    resp = await axios.get<{ values?: Array<{ workspaceId: string }> }>(url, {
      headers: { Authorization: `Bearer ${oauthBearer}`, Accept: "application/json" },
      timeout: 15_000,
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), cloudId },
      "Assets workspace discovery failed",
    );
    throw err;
  }
  const wsId = resp.data.values?.[0]?.workspaceId;
  if (!wsId) {
    throw new Error(`No Assets workspace found for cloudId ${cloudId}`);
  }
  await redis.set(cacheKey, wsId, "EX", TTL_SECONDS);
  return wsId;
}
