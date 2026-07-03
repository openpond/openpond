import { DEFAULT_OPENPOND_API_BASE_URL } from "@openpond/cloud";
import { loadOpenPondAccountContext, type RuntimeAccountContext } from "@openpond/runtime";

export type WebSearchRequest = {
  query: string;
  limit?: number;
  recencyDays?: number;
  domains?: string[];
};

export type WebSearchResultItem = {
  id: string;
  title: string;
  url: string;
  snippet: string;
  sourceName: string | null;
  faviconUrl: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
};

export type WebSearchResult = {
  query: string;
  provider: string;
  searchedAt: string;
  results: WebSearchResultItem[];
  truncated: boolean;
};

export type WebSearchExecutor = (
  request: WebSearchRequest,
  options?: { signal?: AbortSignal },
) => Promise<WebSearchResult>;

type WebSearchAccountContext = Pick<
  RuntimeAccountContext,
  "token" | "apiBaseUrl" | "chatApiBaseUrl"
>;

const DEFAULT_WEB_SEARCH_LIMIT = 5;
const MAX_WEB_SEARCH_LIMIT = 10;
const MAX_WEB_SEARCH_SNIPPET_LENGTH = 1200;

export function createHostedWebSearchExecutor(input: {
  endpoint: string;
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
}): WebSearchExecutor {
  const endpoint = normalizeEndpoint(input.endpoint);
  const fetchImpl = input.fetchImpl ?? fetch;
  const apiKey = input.apiKey?.trim() || null;
  return async (request, options) => {
    const body = normalizeWebSearchRequest(request);
    const headers = new Headers();
    headers.set("Accept", "application/json");
    headers.set("Content-Type", "application/json");
    headers.set("x-openpond-client", "openpond-app");
    if (apiKey) {
      if (apiKey.startsWith("opk_")) headers.set("openpond-api-key", apiKey);
      headers.set("Authorization", `Bearer ${apiKey}`);
    }
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Hosted web search failed: ${response.status} ${await readSearchError(response)}`,
      );
    }
    return normalizeWebSearchResult(await response.json(), body.query);
  };
}

export function createWebSearchExecutorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    fetchImpl?: typeof fetch;
    loadAccountContext?: () => Promise<WebSearchAccountContext>;
  } = {},
): WebSearchExecutor {
  const loadAccountContext = options.loadAccountContext ?? loadOpenPondAccountContext;
  return async (request, searchOptions) => {
    const configuredApiKey = firstNonEmpty(
      env.OPENPOND_WEB_SEARCH_API_KEY,
      env.OPENPOND_SEARCH_API_KEY,
      env.OPENPOND_API_KEY,
    );
    const accountContext = configuredApiKey ? null : await loadAccountContext().catch(() => null);
    const endpoint = resolveWebSearchEndpoint(env, accountContext);
    const apiKey = configuredApiKey ?? accountContext?.token ?? null;
    const execute = createHostedWebSearchExecutor({
      endpoint,
      apiKey,
      fetchImpl: options.fetchImpl,
    });
    return execute(request, searchOptions);
  };
}

export function resolveWebSearchEndpoint(
  env: NodeJS.ProcessEnv = process.env,
  accountContext?: WebSearchAccountContext | null,
): string {
  const exactEndpoint = firstNonEmpty(env.OPENPOND_WEB_SEARCH_ENDPOINT);
  if (exactEndpoint) return normalizeEndpoint(exactEndpoint);

  const explicitSearchApiUrl = firstNonEmpty(env.OPENPOND_SEARCH_API_URL);
  if (explicitSearchApiUrl) return normalizeSearchApiUrl(explicitSearchApiUrl);

  const apiBase = firstNonEmpty(
    env.OPENPOND_PUBLIC_API_URL,
    env.OPENPOND_API_URL,
    accountContext?.apiBaseUrl,
  );
  if (apiBase) return normalizeSearchApiUrl(apiBase);

  const chatBase = firstNonEmpty(
    env.OPENPOND_OPCHAT_API_URL,
    env.OPENPOND_CHAT_API_URL,
    accountContext?.chatApiBaseUrl,
  );
  if (chatBase) return normalizeSearchApiUrl(chatBase);

  return normalizeSearchApiUrl(DEFAULT_OPENPOND_API_BASE_URL);
}

export function normalizeSearchApiUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Hosted web search endpoint is required.");
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Hosted web search endpoint must use http or https.");
  }
  if (
    url.hostname === "api.staging-api.openpond.ai" ||
    url.hostname === "staging-api.openpond.ai"
  ) {
    url.hostname = "api-new.staging-api.openpond.ai";
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const opchatIndex = segments.findIndex((segment) => segment.toLowerCase() === "opchat");
  if (opchatIndex >= 0) {
    url.pathname = `/${[...segments.slice(0, opchatIndex), "v1", "search"].join("/")}`;
  } else {
    const searchIndex = segments.findIndex((segment) => segment.toLowerCase() === "search");
    if (searchIndex >= 0) {
      url.pathname = `/${segments.slice(0, searchIndex + 1).join("/")}`;
    } else {
      const v1Index = segments.findIndex((segment) => segment.toLowerCase() === "v1");
      url.pathname =
        v1Index >= 0
          ? `/${[...segments.slice(0, v1Index + 1), "search"].join("/")}`
          : `${url.pathname.replace(/\/+$/, "")}/v1/search`.replace(/\/{2,}/g, "/");
    }
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function normalizeWebSearchRequest(
  request: WebSearchRequest,
): Required<Pick<WebSearchRequest, "query">> &
  Pick<WebSearchRequest, "limit" | "recencyDays" | "domains"> {
  const query = request.query.trim();
  if (!query) throw new Error("web_search query is required.");
  const limit = normalizeLimit(request.limit);
  const domains = Array.isArray(request.domains)
    ? request.domains
        .map((domain) => domain.trim())
        .filter(Boolean)
        .slice(0, 10)
    : undefined;
  return {
    query,
    limit,
    ...(typeof request.recencyDays === "number" &&
    Number.isFinite(request.recencyDays) &&
    request.recencyDays >= 0
      ? { recencyDays: Math.floor(request.recencyDays) }
      : {}),
    ...(domains && domains.length > 0 ? { domains } : {}),
  };
}

function normalizeEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Hosted web search endpoint is required.");
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Hosted web search endpoint must use http or https.");
  }
  return url.toString();
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function normalizeLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return DEFAULT_WEB_SEARCH_LIMIT;
  return Math.min(Math.floor(value), MAX_WEB_SEARCH_LIMIT);
}

function normalizeWebSearchResult(value: unknown, query: string): WebSearchResult {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawResults = Array.isArray(record.results)
    ? record.results
    : Array.isArray(record.items)
      ? record.items
      : [];
  const results = rawResults
    .map(normalizeWebSearchItem)
    .filter((item): item is WebSearchResultItem => Boolean(item));
  return {
    query: stringValue(record.query) ?? query,
    provider: stringValue(record.provider) ?? "hosted",
    searchedAt:
      stringValue(record.searchedAt) ?? stringValue(record.searched_at) ?? new Date().toISOString(),
    results,
    truncated: record.truncated === true,
  };
}

function normalizeWebSearchItem(value: unknown, index: number): WebSearchResultItem | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const url = stringValue(record.url);
  const title = stringValue(record.title);
  if (!url || !title) return null;
  return {
    id: stringValue(record.id) ?? `result_${index + 1}`,
    title,
    url,
    snippet: normalizeSnippet(
      stringValue(record.snippet) ??
        stringValue(record.description) ??
        stringValue(record.text) ??
        stringValue(record.content),
    ),
    sourceName:
      stringValue(record.sourceName) ??
      stringValue(record.source_name) ??
      stringValue(record.source) ??
      hostnameFromUrl(url),
    faviconUrl:
      normalizeOptionalUrl(
        stringValue(record.faviconUrl) ??
          stringValue(record.favicon_url) ??
          stringValue(record.iconUrl) ??
          stringValue(record.icon_url),
      ) ?? faviconUrlFromPageUrl(url),
    publishedAt:
      stringValue(record.publishedAt) ??
      stringValue(record.published_at) ??
      stringValue(record.publishedDate) ??
      stringValue(record.published_date),
    updatedAt:
      stringValue(record.updatedAt) ??
      stringValue(record.updated_at) ??
      stringValue(record.updatedDate) ??
      stringValue(record.updated_date),
  };
}

function normalizeSnippet(value: string | null): string {
  if (!value) return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_WEB_SEARCH_SNIPPET_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_WEB_SEARCH_SNIPPET_LENGTH - 1).trimEnd()}…`;
}

function normalizeOptionalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function faviconUrlFromPageUrl(value: string): string | null {
  try {
    return new URL("/favicon.ico", value).toString();
  } catch {
    return null;
  }
}

function hostnameFromUrl(value: string): string | null {
  try {
    return new URL(value).hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

async function readSearchError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return response.statusText || `HTTP ${response.status}`;
  try {
    const payload = JSON.parse(text) as unknown;
    if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      const error = record.error;
      if (error && typeof error === "object") {
        const errorRecord = error as Record<string, unknown>;
        return stringValue(errorRecord.message) ?? JSON.stringify(payload);
      }
      return stringValue(record.message) ?? stringValue(record.error) ?? JSON.stringify(payload);
    }
  } catch {
    return text;
  }
  return text;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
