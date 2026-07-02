import { createHash } from "node:crypto";
import {
  ProviderCatalogSchema,
  type ProviderCatalog,
} from "@openpond/contracts";
import { loadOpenPondProviderCatalog } from "@openpond/runtime";
import type { ProvidersFile } from "../types.js";
import { normalizeProvidersFile } from "./provider-settings.js";

const DEFAULT_PROVIDER_CATALOG_TTL_MS = 5 * 60 * 1000;

type HostedProviderCatalogResult = Awaited<ReturnType<typeof loadOpenPondProviderCatalog>>;
type HostedProviderCatalogLoader = () => Promise<HostedProviderCatalogResult>;

let cachedLoader: HostedProviderCatalogLoader | null = null;
let hostedCatalogInFlight: Promise<HostedProviderCatalogResult> | null = null;
let hostedCatalogCache: {
  resolvedAtMs: number;
  result: HostedProviderCatalogResult;
} | null = null;

export type ProviderCatalogResolution = {
  file: ProvidersFile;
  catalog: ProviderCatalog | null;
  source: "hosted" | "cache" | "fallback";
  error: string | null;
};

export function cachedProviderCatalog(
  file: ProvidersFile,
): ProviderCatalog | null {
  return file.catalogCache?.catalog ?? null;
}

export async function resolveProviderCatalog(input: {
  file: ProvidersFile;
  timestamp: string;
  nowMs?: number;
  ttlMs?: number;
  loadHostedCatalog?: HostedProviderCatalogLoader;
}): Promise<ProviderCatalogResolution> {
  const hosted = await loadHostedProviderCatalog({
    loadHostedCatalog: input.loadHostedCatalog ?? loadOpenPondProviderCatalog,
    nowMs: input.nowMs ?? timestampMs(input.timestamp),
    ttlMs: input.ttlMs ?? DEFAULT_PROVIDER_CATALOG_TTL_MS,
  });
  if (hosted.catalog) {
    const catalog = ProviderCatalogSchema.parse(hosted.catalog);
    const catalogHash = providerCatalogContentHash(catalog);
    const cached = cachedProviderCatalog(input.file);
    const cachedHash = input.file.catalogCache?.catalogHash ?? (cached ? providerCatalogContentHash(cached) : null);
    if (cached && cachedHash === catalogHash && input.file.catalogCache?.catalogHash === catalogHash) {
      return {
        file: input.file,
        catalog,
        source: "hosted",
        error: null,
      };
    }
    return {
      file: normalizeProvidersFile({
        ...input.file,
        catalogCache: {
          source: "hosted",
          fetchedAt: input.timestamp,
          lastError: null,
          catalogHash,
          catalog,
        },
      }),
      catalog,
      source: "hosted",
      error: null,
    };
  }

  const cached = cachedProviderCatalog(input.file);
  if (cached) {
    return {
      file: input.file,
      catalog: cached,
      source: "cache",
      error: hosted.error,
    };
  }

  return {
    file: input.file,
    catalog: null,
    source: "fallback",
    error: hosted.error,
  };
}

export function resetProviderCatalogResolverCache(): void {
  cachedLoader = null;
  hostedCatalogInFlight = null;
  hostedCatalogCache = null;
}

export function providerCatalogContentHash(catalog: ProviderCatalog): string {
  const hash = createHash("sha256");
  hash.update(stableStringify({
    version: catalog.version,
    providers: catalog.providers,
  }));
  return `sha256:${hash.digest("hex")}`;
}

async function loadHostedProviderCatalog(input: {
  loadHostedCatalog: HostedProviderCatalogLoader;
  nowMs: number;
  ttlMs: number;
}): Promise<HostedProviderCatalogResult> {
  if (cachedLoader !== input.loadHostedCatalog) {
    cachedLoader = input.loadHostedCatalog;
    hostedCatalogInFlight = null;
    hostedCatalogCache = null;
  }
  const ttlMs = Math.max(0, Math.trunc(input.ttlMs));
  if (
    hostedCatalogCache?.result.catalog &&
    input.nowMs - hostedCatalogCache.resolvedAtMs < ttlMs
  ) {
    return hostedCatalogCache.result;
  }
  if (hostedCatalogInFlight) return hostedCatalogInFlight;
  const inFlight = input.loadHostedCatalog().then((result) => {
    if (result.catalog) {
      hostedCatalogCache = {
        resolvedAtMs: input.nowMs,
        result,
      };
    }
    return result;
  });
  hostedCatalogInFlight = inFlight;
  try {
    return await inFlight;
  } finally {
    if (hostedCatalogInFlight === inFlight) hostedCatalogInFlight = null;
  }
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}
