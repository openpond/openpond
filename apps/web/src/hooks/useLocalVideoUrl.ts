import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ClientConnection } from "../api";

type CachedLocalVideoUrl =
  | { state: "ready"; url: string; expiresAt: number }
  | { state: "loading"; promise: Promise<string | null> };

const cache = new Map<string, CachedLocalVideoUrl>();
const EXPIRY_SKEW_MS = 15_000;

export type LocalVideoUrlResolver = {
  getUrl: (path: string | null | undefined) => string | null;
  loadUrl: (path: string | null | undefined) => Promise<string | null>;
};

export function useLocalVideoUrl(
  connection: ClientConnection | null,
  path: string | null | undefined,
): string | null {
  const resolver = useLocalVideoUrlResolver(connection);
  const [url, setUrl] = useState<string | null>(() => resolver.getUrl(path));

  useEffect(() => {
    let cancelled = false;
    setUrl(resolver.getUrl(path));
    void resolver.loadUrl(path).then((nextUrl) => {
      if (!cancelled) setUrl(nextUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [path, resolver]);

  return url;
}

export function useLocalVideoUrlResolver(connection: ClientConnection | null): LocalVideoUrlResolver {
  const [, setVersion] = useState(0);

  const getUrl = useCallback(
    (path: string | null | undefined) => {
      if (!connection || !path) return null;
      return cachedUrl(cacheKey(connection, path));
    },
    [connection],
  );

  const loadUrl = useCallback(
    async (path: string | null | undefined) => {
      if (!connection || !path) return null;
      const key = cacheKey(connection, path);
      const existingUrl = cachedUrl(key);
      if (existingUrl) return existingUrl;
      const existing = cache.get(key);
      if (existing?.state === "loading") return existing.promise;
      const promise = api
        .signLocalVideoUrl(connection, { path })
        .then((response) => {
          cache.set(key, { state: "ready", url: response.url, expiresAt: response.expiresAt });
          setVersion((version) => version + 1);
          return response.url;
        })
        .catch(() => {
          cache.delete(key);
          setVersion((version) => version + 1);
          return null;
        });
      cache.set(key, { state: "loading", promise });
      return promise;
    },
    [connection],
  );

  return useMemo(() => ({ getUrl, loadUrl }), [getUrl, loadUrl]);
}

function cachedUrl(key: string): string | null {
  const existing = cache.get(key);
  if (existing?.state !== "ready") return null;
  if (existing.expiresAt <= Date.now() + EXPIRY_SKEW_MS) {
    cache.delete(key);
    return null;
  }
  return existing.url;
}

function cacheKey(connection: ClientConnection, path: string): string {
  return `${connection.serverUrl}\0${connection.token}\0${path}`;
}
