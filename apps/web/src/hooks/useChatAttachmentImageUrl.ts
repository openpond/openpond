import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatAttachmentSummary } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import { signedResourceCacheKey, signedResourceUrlCache } from "../lib/signed-resource-url-cache";

type ChatAttachmentImagePreview = NonNullable<ChatAttachmentSummary["imagePreview"]>;

export function useChatAttachmentImageUrl(
  connection: ClientConnection | null,
  preview: ChatAttachmentImagePreview | null | undefined,
): string | null {
  const resolver = useChatAttachmentImageUrlResolver(connection);
  const [url, setUrl] = useState<string | null>(() => resolver.getUrl(preview));

  useEffect(() => {
    let cancelled = false;
    setUrl(resolver.getUrl(preview));
    void resolver.loadUrl(preview).then((nextUrl) => {
      if (!cancelled) setUrl(nextUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [preview, resolver]);

  return url;
}

function useChatAttachmentImageUrlResolver(connection: ClientConnection | null) {
  const [, setVersion] = useState(0);

  const getUrl = useCallback(
    (preview: ChatAttachmentImagePreview | null | undefined) => {
      if (!connection || !preview) return null;
      signedResourceUrlCache.activateConnection(connection);
      return signedResourceUrlCache.get(cacheKey(connection, preview));
    },
    [connection],
  );

  const loadUrl = useCallback(
    async (preview: ChatAttachmentImagePreview | null | undefined) => {
      if (!connection || !preview) return null;
      const key = cacheKey(connection, preview);
      signedResourceUrlCache.activateConnection(connection);
      return signedResourceUrlCache
        .load(key, () => api.signChatAttachmentImageUrl(connection, preview))
        .finally(() => setVersion((version) => version + 1));
    },
    [connection],
  );

  return useMemo(() => ({ getUrl, loadUrl }), [getUrl, loadUrl]);
}

function cacheKey(connection: ClientConnection, preview: ChatAttachmentImagePreview): string {
  return signedResourceCacheKey(
    connection,
    "chat-attachment-image",
    preview.sessionId,
    preview.turnId,
    preview.attachmentId,
    preview.storageName,
    preview.contentType,
  );
}
