export async function apiFetch(
  baseUrl: string,
  token: string | null,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const headers = new Headers(init?.headers || {});
  headers.set("Content-Type", "application/json");
  const apiKey = process.env.OPENPOND_API_KEY;
  const trimmedToken = token?.trim() || "";
  const tokenIsApiKey = trimmedToken.startsWith("opk_");
  const effectiveApiKey = apiKey || (tokenIsApiKey ? trimmedToken : null);
  if (effectiveApiKey && !headers.has("openpond-api-key")) {
    headers.set("openpond-api-key", effectiveApiKey);
  }
  if (token) {
    headers.set(
      "Authorization",
      tokenIsApiKey ? `ApiKey ${trimmedToken}` : `Bearer ${token}`
    );
  } else if (apiKey && !headers.has("Authorization")) {
    headers.set("Authorization", `ApiKey ${apiKey}`);
  }
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
  });
}

export async function readApiJson<T>(
  response: Response,
  label: string
): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: unknown;
    message?: unknown;
  };
  if (!response.ok) {
    const message =
      typeof payload.message === "string"
        ? payload.message
        : typeof payload.error === "string"
        ? payload.error
        : "";
    throw new Error(
      `${label} failed: ${response.status}${message ? ` ${message}` : ""}`
    );
  }
  return payload as T;
}
