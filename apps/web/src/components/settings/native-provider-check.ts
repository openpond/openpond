import type { ChatProvider, ProviderConfigPatch, ProviderSettings } from "@openpond/contracts";

export type NativeProviderCheck = {
  status: "ready" | "missing" | "needs_login" | "unavailable";
  error: string | null;
  version: string | null;
  settings: ProviderSettings;
};
export type CheckNativeProvider = (
  provider: ChatProvider,
  signal: AbortSignal,
  patch?: ProviderConfigPatch,
) => Promise<NativeProviderCheck>;
