import { apiFetch } from "@openpond/cloud/api";
import { normalizeSandboxApiUrl } from "@openpond/cloud/sandbox/url";
import type { RuntimeAccountContext } from "@openpond/runtime";

type AccountRequest = {
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: Record<string, unknown>;
  idempotencyKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** Pins one login and optional workspace without a Ponder or sandbox credential. */
export function createCapturedOpenPondPublicApiClient(context: RuntimeAccountContext, teamId?: string) {
  const apiKey = context.token?.trim();
  if (!apiKey || context.accountState.state !== "signed_in" || !context.accountState.activeProfile)
    throw new Error("A signed-in OpenPond account is required.");
  const normalized = normalizeSandboxApiUrl(context.apiBaseUrl);
  const root = /\/api\/sandboxes\/?$/.test(normalized)
    ? normalized.replace(/\/api\/sandboxes\/?$/, "/v1")
    : normalized.replace(/\/sandboxes\/?$/, "");
  return {
    audience: new URL(root).origin,
    async request(params: AccountRequest): Promise<Record<string, unknown>> {
      const apiKeyAuth = apiKey.startsWith("opk_");
      const response = await apiFetch(root, apiKey, params.path, {
        method: params.method ?? "GET",
        signal: params.signal,
        explicitBearerAuth: !apiKeyAuth,
        headers: {
          ...(apiKeyAuth ? { "openpond-api-key": apiKey } : {}),
          ...(params.idempotencyKey ? { "idempotency-key": params.idempotencyKey } : {}),
          ...(teamId ? { "X-OpenPond-Team-Id": teamId } : {}),
        },
        ...(params.body ? { body: JSON.stringify(params.body) } : {}),
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(typeof payload.error === "string"
        ? payload.error : `OpenPond API request failed with status ${response.status}`);
      return payload;
    },
  };
}
