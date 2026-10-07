import { useCallback, useMemo, useState } from "react";
import { useSignedImageResource } from "./useSignedImageResource";
import { api, type ClientConnection } from "../api";
import { signedResourceCacheKey, signedResourceUrlCache } from "../lib/signed-resource-url-cache";

export type LocalImageUrlResolver = {
  getUrl: (path: string | null | undefined) => string | null;
  loadUrl: (path: string | null | undefined) => Promise<string | null>;
};

export function useLocalImageUrl(
  connection: ClientConnection | null,
  path: string | null | undefined,
): string | null {
  return useLocalImageResource(connection, path).url;
}

export function useLocalImageResource(connection: ClientConnection | null, path: string | null | undefined) {
  const load = useCallback(() => api.signLocalImageUrl(connection!, { path: path! }), [connection, path]);
  return useSignedImageResource(connection,
    connection && path ? signedResourceCacheKey(connection, "local-image", path) : null, load);
}

export function useLocalImageUrlResolver(connection: ClientConnection | null): LocalImageUrlResolver {
  const [, setVersion] = useState(0);

  const getUrl = useCallback(
    (path: string | null | undefined) => {
      if (!connection || !path) return null;
      signedResourceUrlCache.activateConnection(connection);
      return signedResourceUrlCache.get(signedResourceCacheKey(connection, "local-image", path));
    },
    [connection],
  );

  const loadUrl = useCallback(
    async (path: string | null | undefined) => {
      if (!connection || !path) return null;
      signedResourceUrlCache.activateConnection(connection);
      const key = signedResourceCacheKey(connection, "local-image", path);
      return signedResourceUrlCache
        .load(key, () => api.signLocalImageUrl(connection, { path }))
        .finally(() => setVersion((version) => version + 1));
    },
    [connection],
  );

  return useMemo(() => ({ getUrl, loadUrl }), [getUrl, loadUrl]);
}
