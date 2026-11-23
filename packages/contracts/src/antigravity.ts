import type { ProviderSettings } from "./providers.js";

export const ANTIGRAVITY_PROVIDER_ID = "acp:antigravity" as const;

export type AntigravityRuntimeState = {
  phase: "idle" | "checking" | "downloading" | "installing" | "failed";
  version: string | null;
  latestVersion: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
};

export type AntigravityLoginState = {
  id: string;
  phase: "starting" | "waiting_for_code" | "verifying" | "complete" | "failed" | "cancelled";
  authorizationUrl: string | null;
  expiresAt: string;
  error: string | null;
};

export type AntigravitySetupState = {
  runtime: AntigravityRuntimeState;
  enabled: boolean;
  status: "missing" | "needs_login" | "ready" | "unavailable";
  error: string | null;
  login: AntigravityLoginState | null;
  settings?: ProviderSettings;
};
