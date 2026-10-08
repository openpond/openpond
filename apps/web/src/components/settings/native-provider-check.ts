import type { ChatProvider, ProviderConfigPatch, ProviderSettings } from "@openpond/contracts";

export type NativeProviderCheck = {
  status: "ready" | "missing" | "needs_login" | "unavailable";
  error: string | null;
  version: string | null;
  authMethods?: Array<{ id: string; name: string; description?: string; type?: string }>;
  settings: ProviderSettings;
};
export type CheckNativeProvider = (
  provider: ChatProvider,
  signal: AbortSignal,
  patch?: ProviderConfigPatch,
) => Promise<NativeProviderCheck>;
