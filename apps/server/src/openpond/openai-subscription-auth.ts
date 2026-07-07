import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { ProviderChatGptSubscriptionCredential } from "./provider-secrets.js";

const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_OAUTH_ISSUER = "https://auth.openai.com";
const OPENAI_OAUTH_PORT = 1455;
const OPENAI_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const OPENAI_OAUTH_POLL_INTERVAL_MS = 5_000;
const OPENAI_OAUTH_POLL_SAFETY_MARGIN_MS = 3_000;

type PkceCodes = {
  verifier: string;
  challenge: string;
};

type OpenAiOAuthTokenResponse = {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

type PendingBrowserOAuth = {
  pkce: PkceCodes;
  state: string;
  resolve: (tokens: OpenAiOAuthTokenResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type OpenAiSubscriptionAuthService = ReturnType<typeof createOpenAiSubscriptionAuthService>;

export function createOpenAiSubscriptionAuthService(input: {
  saveCredential: (credential: ProviderChatGptSubscriptionCredential) => Promise<void>;
}) {
  let oauthServer: Server | null = null;
  let pendingBrowserOAuth: PendingBrowserOAuth | null = null;

  async function startBrowserLogin(): Promise<{
    url: string;
    redirectUri: string;
    expiresAt: number;
  }> {
    const { redirectUri } = await ensureOAuthServer();
    const pkce = generatePkce();
    const state = base64Url(randomBytes(32));
    if (pendingBrowserOAuth) {
      pendingBrowserOAuth.reject(new Error("A previous OpenAI ChatGPT login was replaced."));
      clearTimeout(pendingBrowserOAuth.timeout);
      pendingBrowserOAuth = null;
    }
    const expiresAt = Date.now() + OPENAI_OAUTH_TIMEOUT_MS;
    const callbackPromise = new Promise<OpenAiOAuthTokenResponse>((resolve, reject) => {
      pendingBrowserOAuth = {
        pkce,
        state,
        resolve,
        reject,
        timeout: setTimeout(() => {
          pendingBrowserOAuth = null;
          reject(new Error("OpenAI ChatGPT login timed out."));
        }, OPENAI_OAUTH_TIMEOUT_MS),
      };
    });
    void callbackPromise
      .then((tokens) => saveTokens(tokens))
      .catch(() => undefined)
      .finally(() => stopOAuthServer());
    return {
      url: buildAuthorizeUrl(redirectUri, pkce, state),
      redirectUri,
      expiresAt,
    };
  }

  async function startDeviceLogin(): Promise<{
    url: string;
    userCode: string;
    expiresAt: number;
  }> {
    const response = await fetch(`${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "openpond-app",
      },
      body: JSON.stringify({ client_id: OPENAI_OAUTH_CLIENT_ID }),
    });
    if (!response.ok) throw new Error(`OpenAI device authorization failed: ${response.status}`);
    const data = (await response.json()) as {
      device_auth_id?: string;
      user_code?: string;
      interval?: string;
    };
    if (!data.device_auth_id || !data.user_code) {
      throw new Error("OpenAI device authorization returned an incomplete response.");
    }
    const intervalMs =
      Math.max(Number.parseInt(data.interval ?? "", 10) || OPENAI_OAUTH_POLL_INTERVAL_MS / 1000, 1) * 1000;
    const expiresAt = Date.now() + OPENAI_OAUTH_TIMEOUT_MS;
    void pollDeviceLogin({
      deviceAuthId: data.device_auth_id,
      userCode: data.user_code,
      intervalMs,
      expiresAt,
    }).catch(() => undefined);
    return {
      url: `${OPENAI_OAUTH_ISSUER}/codex/device`,
      userCode: data.user_code,
      expiresAt,
    };
  }

  async function pollDeviceLogin(input: {
    deviceAuthId: string;
    userCode: string;
    intervalMs: number;
    expiresAt: number;
  }): Promise<void> {
    while (Date.now() < input.expiresAt) {
      const response = await fetch(`${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "openpond-app",
        },
        body: JSON.stringify({
          device_auth_id: input.deviceAuthId,
          user_code: input.userCode,
        }),
      });
      if (response.ok) {
        const data = (await response.json()) as { authorization_code?: string; code_verifier?: string };
        if (!data.authorization_code || !data.code_verifier) {
          throw new Error("OpenAI device login returned an incomplete authorization response.");
        }
        await saveTokens(
          await exchangeCodeForTokens(data.authorization_code, `${OPENAI_OAUTH_ISSUER}/deviceauth/callback`, {
            verifier: data.code_verifier,
          }),
        );
        return;
      }
      if (response.status !== 403 && response.status !== 404) {
        throw new Error(`OpenAI device login failed: ${response.status}`);
      }
      await sleep(input.intervalMs + OPENAI_OAUTH_POLL_SAFETY_MARGIN_MS);
    }
    throw new Error("OpenAI device login timed out.");
  }

  async function ensureOAuthServer(): Promise<{ redirectUri: string }> {
    if (oauthServer) {
      return { redirectUri: `http://localhost:${OPENAI_OAUTH_PORT}/auth/callback` };
    }
    oauthServer = createServer((request, response) => {
      const url = new URL(request.url || "/", `http://localhost:${OPENAI_OAUTH_PORT}`);
      if (url.pathname !== "/auth/callback") {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      const current = pendingBrowserOAuth;
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");
      if (error) {
        failBrowserOAuth(errorDescription || error);
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(htmlPage("Authorization Failed", errorDescription || error));
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code) {
        failBrowserOAuth("Missing authorization code.");
        response.writeHead(400, { "Content-Type": "text/html" });
        response.end(htmlPage("Authorization Failed", "Missing authorization code."));
        return;
      }
      if (!current || state !== current.state) {
        failBrowserOAuth("Invalid OAuth state.");
        response.writeHead(400, { "Content-Type": "text/html" });
        response.end(htmlPage("Authorization Failed", "Invalid OAuth state."));
        return;
      }
      pendingBrowserOAuth = null;
      clearTimeout(current.timeout);
      exchangeCodeForTokens(code, `http://localhost:${OPENAI_OAUTH_PORT}/auth/callback`, current.pkce)
        .then(current.resolve)
        .catch(current.reject);
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(htmlPage("Authorization Successful", "You can close this window and return to OpenPond."));
    });
    await new Promise<void>((resolve, reject) => {
      oauthServer!.once("error", reject);
      oauthServer!.listen(OPENAI_OAUTH_PORT, () => {
        oauthServer!.off("error", reject);
        resolve();
      });
    });
    return { redirectUri: `http://localhost:${OPENAI_OAUTH_PORT}/auth/callback` };
  }

  function failBrowserOAuth(message: string): void {
    const current = pendingBrowserOAuth;
    pendingBrowserOAuth = null;
    if (!current) return;
    clearTimeout(current.timeout);
    current.reject(new Error(message));
  }

  function stopOAuthServer(): void {
    const server = oauthServer;
    oauthServer = null;
    if (!server) return;
    server.close();
  }

  async function saveTokens(tokens: OpenAiOAuthTokenResponse): Promise<void> {
    const accessToken = tokens.access_token?.trim() || null;
    const refreshToken = tokens.refresh_token?.trim();
    if (!refreshToken) throw new Error("OpenAI login did not return a refresh token.");
    await input.saveCredential({
      accessToken,
      refreshToken,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      accountId: extractAccountId(tokens),
    });
  }

  return {
    startBrowserLogin,
    startDeviceLogin,
  };
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "openpond",
  });
  return `${OPENAI_OAUTH_ISSUER}/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  pkce: Pick<PkceCodes, "verifier">,
): Promise<OpenAiOAuthTokenResponse> {
  const response = await fetch(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: OPENAI_OAUTH_CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  });
  if (!response.ok) throw new Error(`OpenAI token exchange failed: ${response.status}`);
  return (await response.json()) as OpenAiOAuthTokenResponse;
}

export async function refreshOpenAiSubscriptionToken(refreshToken: string): Promise<OpenAiOAuthTokenResponse> {
  const response = await fetch(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_OAUTH_CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) throw new Error(`OpenAI token refresh failed: ${response.status}`);
  return (await response.json()) as OpenAiOAuthTokenResponse;
}

export function credentialFromRefreshResponse(
  tokens: OpenAiOAuthTokenResponse,
  previous: ProviderChatGptSubscriptionCredential,
): ProviderChatGptSubscriptionCredential {
  return {
    accessToken: tokens.access_token?.trim() || previous.accessToken,
    refreshToken: tokens.refresh_token?.trim() || previous.refreshToken,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(tokens) ?? previous.accountId,
  };
}

function generatePkce(): PkceCodes {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function extractAccountId(tokens: OpenAiOAuthTokenResponse): string | null {
  for (const token of [tokens.id_token, tokens.access_token]) {
    const claims = parseJwtClaims(token);
    const direct = stringValue(claims?.chatgpt_account_id);
    if (direct) return direct;
    const namespaced = claims?.["https://api.openai.com/auth"];
    if (namespaced && typeof namespaced === "object") {
      const value = stringValue((namespaced as Record<string, unknown>).chatgpt_account_id);
      if (value) return value;
    }
    const organizations = claims?.organizations;
    if (Array.isArray(organizations)) {
      for (const organization of organizations) {
        if (organization && typeof organization === "object") {
          const value = stringValue((organization as Record<string, unknown>).id);
          if (value) return value;
        }
      }
    }
  }
  return null;
}

function parseJwtClaims(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function htmlPage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>OpenPond - ${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function base64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
