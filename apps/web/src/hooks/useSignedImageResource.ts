import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientConnection } from "../api";
import { signedResourceUrlCache, type SignedResourceState } from "../lib/signed-resource-url-cache";

/** Shared lifecycle for inline image previews and their signed URLs. */
export function useSignedImageResource(
  connection: ClientConnection | null,
  key: string | null,
  load: () => Promise<{ expiresAt: number; url: string }>,
) {
  const [state, setState] = useState<SignedResourceState & { key: string | null }>({ key, url: null, status: "loading" });
  const observer = useRef<ReturnType<typeof signedResourceUrlCache.watch> | null>(null);
  useEffect(() => {
    if (!connection || !key) return;
    signedResourceUrlCache.activateConnection(connection);
    const watched = signedResourceUrlCache.watch(key, load, (next) => setState({ ...next, key }));
    observer.current = watched;
    const refresh = () => { if (document.visibilityState !== "hidden") watched.refresh(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("openpond-runtime-connected", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      watched.close();
      observer.current = null;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("openpond-runtime-connected", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [connection, key, load]);
  const retry = useCallback(() => observer.current?.refresh(true), []);
  return { ...(state.key === key && connection && key ? state : { url: null, status: "loading" as const }), retry };
}
