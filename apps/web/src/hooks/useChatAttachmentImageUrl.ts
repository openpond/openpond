import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatAttachmentSummary } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";

type ChatAttachmentImagePreview = NonNullable<ChatAttachmentSummary["imagePreview"]>;

type CachedChatAttachmentImageUrl =
  | { state: "ready"; url: string; expiresAt: number }
  | { state: "loading"; promise: Promise<string | null> };

const cache = new Map<string, CachedChatAttachmentImageUrl>();
const EXPIRY_SKEW_MS = 15_000;

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
      return cachedUrl(cacheKey(connection, preview));
    },
    [connection],
  );

  const loadUrl = useCallback(
    async (preview: ChatAttachmentImagePreview | null | undefined) => {
      if (!connection || !preview) return null;
      const key = cacheKey(connection, preview);
      const existingUrl = cachedUrl(key);
      if (existingUrl) return existingUrl;
      const existing = cache.get(key);
      if (existing?.state === "loading") return existing.promise;
      const promise = api
        .signChatAttachmentImageUrl(connection, preview)
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

function cacheKey(connection: ClientConnection, preview: ChatAttachmentImagePreview): string {
  return [
    connection.serverUrl,
    connection.token,
    preview.sessionId,
    preview.turnId,
    preview.attachmentId,
    preview.storageName,
    preview.contentType,
  ].join("\0");
}
