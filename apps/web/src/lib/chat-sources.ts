import type { RuntimeEvent } from "@openpond/contracts";
import type { ChatSource } from "./app-models";
import { asRecord, parseMaybeJson, stringValue } from "./chat-message-utils";

const MAX_MESSAGE_SOURCES = 8;

export function webSearchSourcesFromEvent(item: RuntimeEvent): ChatSource[] {
  if (item.name !== "tool.completed" || item.status === "failed") {
    return [];
  }
  if (item.action !== "web_search" && item.action !== "web_fetch") {
    return [];
  }

  const dataResult = extractWebSearchResult(item.data);
  const outputResult = item.output ? extractWebSearchResult(parseMaybeJson(item.output)) : null;
  return sourcesFromSearchResult(dataResult ?? outputResult);
}

export function mergeChatSources(
  previous: ChatSource[] | undefined,
  additions: ChatSource[],
): ChatSource[] | undefined {
  if (additions.length === 0) return previous;
  const merged: ChatSource[] = [];
  const seen = new Set<string>();
  for (const source of [...(previous ?? []), ...additions]) {
    const key = normalizeSourceKey(source.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(source);
    if (merged.length >= MAX_MESSAGE_SOURCES) break;
  }
  return merged.length > 0 ? merged : undefined;
}

type SearchResultProjection = {
  provider: string | null;
  results: unknown[];
};

function extractWebSearchResult(value: unknown, depth = 0): SearchResultProjection | null {
  if (depth > 5) return null;
  const record = asRecord(value);
  if (!record) return null;

  const results = Array.isArray(record.results)
    ? record.results
    : Array.isArray(record.items)
      ? record.items
      : stringValue(record, ["url"])
        ? [record]
        : null;
  if (results) {
    return {
      provider: stringValue(record, ["provider"]),
      results,
    };
  }

  for (const key of ["result", "data", "output"]) {
    const nested = extractWebSearchResult(record[key], depth + 1);
    if (nested) return nested;
  }

  return null;
}

function sourcesFromSearchResult(result: SearchResultProjection | null): ChatSource[] {
  if (!result) return [];
  const sources: ChatSource[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < result.results.length; index += 1) {
    const source = sourceFromSearchItem(result.results[index], index, result.provider);
    if (!source) continue;
    const key = normalizeSourceKey(source.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    sources.push(source);
    if (sources.length >= MAX_MESSAGE_SOURCES) break;
  }
  return sources;
}

function sourceFromSearchItem(
  value: unknown,
  index: number,
  provider: string | null,
): ChatSource | null {
  const record = asRecord(value);
  if (!record) return null;
  const url = stringValue(record, ["url", "href"]);
  if (!url || !isHttpUrl(url)) return null;
  const title = stringValue(record, ["title"]) ?? hostnameFromUrl(url) ?? `Source ${index + 1}`;
  return {
    id: stringValue(record, ["id"]) ?? `source_${index + 1}`,
    title,
    url,
    sourceName: stringValue(record, ["sourceName", "source_name", "source"]) ?? hostnameFromUrl(url),
    snippet: stringValue(record, ["snippet", "description"]),
    provider,
    faviconUrl:
      normalizeOptionalUrl(
        stringValue(record, ["faviconUrl", "favicon_url", "iconUrl", "icon_url"]),
      ) ?? faviconUrlFromPageUrl(url),
    publishedAt: stringValue(record, ["publishedAt", "published_at"]),
    updatedAt: stringValue(record, ["updatedAt", "updated_at"]),
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeSourceKey(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
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
