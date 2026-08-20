import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ClientConnection } from "../api";
import { signedResourceCacheKey, signedResourceUrlCache } from "../lib/signed-resource-url-cache";

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
      signedResourceUrlCache.activateConnection(connection);
      return signedResourceUrlCache.get(
        signedResourceCacheKey(connection, "workspace-image", appId, path),
      );
    },
    [connection],
  );

  const loadUrl = useCallback(
    async (appId: string | null | undefined, path: string | null | undefined) => {
      if (!connection || !appId || !path) return null;
      signedResourceUrlCache.activateConnection(connection);
      const key = signedResourceCacheKey(connection, "workspace-image", appId, path);
      return signedResourceUrlCache
        .load(key, () => api.signWorkspaceImageUrl(connection, { appId, path }))
        .finally(() => setVersion((version) => version + 1));
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
