import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ClientConnection } from "../api";
import { signedResourceCacheKey, signedResourceUrlCache } from "../lib/signed-resource-url-cache";

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
      signedResourceUrlCache.activateConnection(connection);
      return signedResourceUrlCache.get(signedResourceCacheKey(connection, "local-video", path));
    },
    [connection],
  );

  const loadUrl = useCallback(
    async (path: string | null | undefined) => {
      if (!connection || !path) return null;
      signedResourceUrlCache.activateConnection(connection);
      const key = signedResourceCacheKey(connection, "local-video", path);
      return signedResourceUrlCache
        .load(key, () => api.signLocalVideoUrl(connection, { path }))
        .finally(() => setVersion((version) => version + 1));
    },
    [connection],
  );

  return useMemo(() => ({ getUrl, loadUrl }), [getUrl, loadUrl]);
}
