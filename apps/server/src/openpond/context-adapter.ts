import type { ChatProvider } from "@openpond/contracts";
import { isManagedLocalChatProvider } from "./managed-chat-provider.js";

export type AppSummaryContextAdapter = {
  kind: "app_summary";
  provider: ChatProvider;
  route: "openpond_hosted" | "local_byok";
};

export type UnsupportedContextAdapter = {
  kind: "unsupported";
  provider: ChatProvider;
  reason: string;
};

export type ContextCompactionAdapter = AppSummaryContextAdapter | UnsupportedContextAdapter;

export function resolveContextCompactionAdapter(provider: ChatProvider): ContextCompactionAdapter {
  if (provider === "openpond") {
    return {
      kind: "app_summary",
      provider,
      route: "openpond_hosted",
    };
  }
  if (isManagedLocalChatProvider(provider)) {
    return {
      kind: "app_summary",
      provider,
      route: "local_byok",
    };
  }
  return {
    kind: "unsupported",
    provider,
    reason: `App-owned context compaction is not enabled for ${provider}.`,
  };
}
