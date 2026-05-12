import axios from "axios";
import { atlassianApiBase } from "./client.js";

export interface AtlassianMe {
  account_id: string;
  name: string;
  email: string | null;
}

export interface AccessibleResource {
  id: string; // cloudId
  name: string;
  scopes: string[];
  url: string;
  avatarUrl?: string;
}

export interface AtlassianTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export async function exchangeCodeForAtlassianTokens(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<AtlassianTokenResponse> {
  const resp = await axios.post<AtlassianTokenResponse>(
    "https://auth.atlassian.com/oauth/token",
    {
      grant_type: "authorization_code",
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
    },
    {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      timeout: 15_000,
    },
  );
  return resp.data;
}

export async function refreshAtlassianTokens(args: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<AtlassianTokenResponse> {
  const resp = await axios.post<AtlassianTokenResponse>(
    "https://auth.atlassian.com/oauth/token",
    {
      grant_type: "refresh_token",
      client_id: args.clientId,
      client_secret: args.clientSecret,
      refresh_token: args.refreshToken,
    },
    {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      timeout: 15_000,
    },
  );
  return resp.data;
}

export async function fetchAtlassianMe(accessToken: string): Promise<AtlassianMe> {
  const resp = await axios.get<AtlassianMe>(`${atlassianApiBase()}/me`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    timeout: 15_000,
  });
  const body = resp.data;
  return {
    account_id: body.account_id,
    name: body.name,
    email: body.email ?? null,
  };
}

export async function fetchAccessibleResources(
  accessToken: string,
): Promise<AccessibleResource[]> {
  const resp = await axios.get<AccessibleResource[]>(
    `${atlassianApiBase()}/oauth/token/accessible-resources`,
    {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      timeout: 15_000,
    },
  );
  return resp.data;
}
