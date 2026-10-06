import { useEffect, useRef } from "react";
import type { ProviderSettings } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { apiFetch } from "../../api/api-client";
import { acquireNativeAgentCatalog, saveNativeAgentCatalog, type NativeAgentCatalog } from "../chat/native-agent-catalog";

/** Reuse composer capability discovery; do not invent readiness from cached model names. */
export function useNativeAgentConnections(
  connection: ClientConnection | null,
  providers: ProviderSettings | undefined,
  onProvider: (provider: string, value: ProviderSettings) => void,
  revision: number,
) {
  const latest = useRef({ providers, onProvider });
  latest.current = { providers, onProvider };
  const instanceKey = JSON.stringify(
    ["claude-code", "opencode", "grok-build"].map((id) => {
      const config = providers?.providers[id];
      return [id, config?.binaryPath, config?.sourceHome, config?.enabled];
    }),
  );
  useEffect(() => {
    if (!connection || !latest.current.providers) return;
    let stopped = false;
    const requests = ["claude-code", "opencode", "grok-build"].map(
      (provider) => {
        const config = latest.current.providers?.providers[provider];
        const controller = new AbortController();
        const request = revision > 0 ? {
          promise: apiFetch<NativeAgentCatalog>(connection, `/v1/providers/${provider}/native-setup`, { method: "POST", body: JSON.stringify({ action: "check" }), signal: controller.signal }),
          release: () => controller.abort(),
        } : acquireNativeAgentCatalog(
          connection,
          provider,
          latest.current.providers?.providers[provider],
        );
        void request.promise.then(
          (value) => {
            if (!stopped) {
              if (revision > 0 && value.session && !value.error) saveNativeAgentCatalog(connection, provider, value, config);
              latest.current.onProvider(provider, value.settings);
            }
          },
          () => {
            /* Explicit setup dialog exposes probe errors. */
          },
        );
        return request;
      },
    );
    return () => {
      stopped = true;
      requests.forEach((request) => request.release());
    };
  }, [connection, instanceKey, revision]);
}
