import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ClientConnection } from "../api";

type CachedWorkspaceImageUrl =
  | { state: "ready"; url: string; expiresAt: number }
  | { state: "loading"; promise: Promise<string | null> };

const cache = new Map<string, CachedWorkspaceImageUrl>();
const EXPIRY_SKEW_MS = 15_000;

export type WorkspaceImageUrlResolver = {
  ensureUrl: (appId: string | null | undefined, path: string | null | undefined) => void;
  getUrl: (appId: string | null | undefined, path: string | null | undefined) => string | null;
  loadUrl: (appId: string | null | undefined, path: string | null | undefined) => Promise<string | null>;
};

export function useWorkspaceImageUrl(
  connection: ClientConnection | null,
  appId: string | null | undefined,
  path: string | null | undefined,
): string | null {
  const resolver = useWorkspaceImageUrlResolver(connection);
  const [url, setUrl] = useState<string | null>(() => resolver.getUrl(appId, path));

  useEffect(() => {
    let cancelled = false;
    setUrl(resolver.getUrl(appId, path));
    void resolver.loadUrl(appId, path).then((nextUrl) => {
      if (!cancelled) setUrl(nextUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [appId, path, resolver]);

  return url;
}

export function useWorkspaceImageUrlResolver(connection: ClientConnection | null): WorkspaceImageUrlResolver {
  const [, setVersion] = useState(0);

  const getUrl = useCallback(
    (appId: string | null | undefined, path: string | null | undefined) => {
      if (!connection || !appId || !path) return null;
      return cachedUrl(cacheKey(connection, appId, path));
    },
    [connection],
  );

  const loadUrl = useCallback(
    async (appId: string | null | undefined, path: string | null | undefined) => {
      if (!connection || !appId || !path) return null;
      const key = cacheKey(connection, appId, path);
      const existingUrl = cachedUrl(key);
      if (existingUrl) return existingUrl;
      const existing = cache.get(key);
      if (existing?.state === "loading") return existing.promise;
      const promise = api
        .signWorkspaceImageUrl(connection, { appId, path })
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

  const ensureUrl = useCallback(
    (appId: string | null | undefined, path: string | null | undefined) => {
      void loadUrl(appId, path);
    },
    [loadUrl],
  );

  return useMemo(() => ({ ensureUrl, getUrl, loadUrl }), [ensureUrl, getUrl, loadUrl]);
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

function cacheKey(connection: ClientConnection, appId: string, path: string): string {
  return `${connection.serverUrl}\0${connection.token}\0${appId}\0${path}`;
}
