import { useEffect, useMemo, useState } from "react";
import type { FileOutputRef } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import { sortOutputFilesNewestFirst } from "./output-file-model";

type OutputCacheEntry = {
  outputs: FileOutputRef[];
  refreshedAt: number;
  request: Promise<FileOutputRef[]> | null;
};

type CachedWorkOutputs = {
  error: string | null;
  loading: boolean;
  outputs: FileOutputRef[];
};

const OUTPUT_CACHE_FRESH_MS = 15_000;
const outputCache = new Map<string, OutputCacheEntry>();

export function useCachedWorkOutputs(
  connection: ClientConnection | null,
): CachedWorkOutputs {
  const cacheKey = useMemo(
    () => (connection ? connectionCacheKey(connection) : null),
    [connection],
  );
  const initialOutputs = cacheKey ? cachedSnapshot(cacheKey) : null;
  const [outputs, setOutputs] = useState<FileOutputRef[]>(initialOutputs ?? []);
  const [loading, setLoading] = useState(Boolean(connection) && !initialOutputs);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!connection || !cacheKey) {
      setOutputs([]);
      setLoading(false);
      setError(null);
      return;
    }

    const snapshot = cachedSnapshot(cacheKey);
    setOutputs(snapshot ?? []);
    setLoading(!snapshot);
    setError(null);

    void loadCachedWorkOutputs(connection)
      .then((nextOutputs) => {
        if (!cancelled) setOutputs(nextOutputs);
      })
      .catch((caught) => {
        if (!cancelled) setError(outputErrorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, connection]);

  return { error, loading, outputs };
}

function cachedSnapshot(cacheKey: string): FileOutputRef[] | null {
  const cached = outputCache.get(cacheKey);
  return cached && cached.refreshedAt > 0 ? cached.outputs : null;
}

export function loadCachedWorkOutputs(
  connection: ClientConnection,
): Promise<FileOutputRef[]> {
  const cacheKey = connectionCacheKey(connection);
  const cached = outputCache.get(cacheKey);
  if (cached?.request) return cached.request;
  if (
    cached &&
    cached.refreshedAt > 0 &&
    Date.now() - cached.refreshedAt < OUTPUT_CACHE_FRESH_MS
  ) {
    return Promise.resolve(cached.outputs);
  }

  const request = api
    .workOutputs(connection)
    .then((response) => sortOutputFilesNewestFirst(response.outputs))
    .then((nextOutputs) => {
      outputCache.set(cacheKey, {
        outputs: nextOutputs,
        refreshedAt: Date.now(),
        request: null,
      });
      return nextOutputs;
    })
    .catch((error) => {
      if (cached) outputCache.set(cacheKey, { ...cached, request: null });
      else outputCache.delete(cacheKey);
      throw error;
    });

  outputCache.set(cacheKey, {
    outputs: cached?.outputs ?? [],
    refreshedAt: cached?.refreshedAt ?? 0,
    request,
  });
  return request;
}

export function clearCachedWorkOutputs(): void {
  outputCache.clear();
}

function connectionCacheKey(connection: ClientConnection): string {
  return `${connection.serverUrl}\0${connection.token}`;
}

function outputErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Could not load Work outputs.";
}
