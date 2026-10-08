import { useCallback, useMemo, useState } from "react";
import { useSignedImageResource } from "./useSignedImageResource";
import { api, type ClientConnection } from "../api";
import { signedResourceCacheKey, signedResourceUrlCache } from "../lib/signed-resource-url-cache";

export type WorkspaceImageUrlResolver = {
  ensureUrl: (appId: string | null | undefined, path: string | null | undefined) => void;
  getUrl: (appId: string | null | undefined, path: string | null | undefined) => string | null;
  loadUrl: (appId: string | null | undefined, path: string | null | undefined) => Promise<string | null>;
};

function signImageUrl(connection: ClientConnection, appId: string, path: string) {
  // Resolved links can point into another source folder or an explicit output
  // directory. The workspace signing endpoint only accepts relative paths.
  return /^(?:[~/\\]|[A-Za-z]:|file:\/\/)/.test(path)
    ? api.signLocalImageUrl(connection, { path })
    : api.signWorkspaceImageUrl(connection, { appId, path });
}

export function useWorkspaceImageUrl(
  connection: ClientConnection | null,
  appId: string | null | undefined,
  path: string | null | undefined,
): string | null {
  return useWorkspaceImageResource(connection, appId, path).url;
}

export function useWorkspaceImageResource(connection: ClientConnection | null, appId: string | null | undefined, path: string | null | undefined) {
  const load = useCallback(() => signImageUrl(connection!, appId!, path!), [connection, appId, path]);
  return useSignedImageResource(connection,
    connection && appId && path ? signedResourceCacheKey(connection, "workspace-image", appId, path) : null, load);
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
        .load(key, () => signImageUrl(connection, appId, path))
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
