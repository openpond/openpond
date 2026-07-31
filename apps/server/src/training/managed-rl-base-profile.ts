import type { BaseModelPreference } from "@openpond/contracts";

export type ManagedRlBaseProfile = {
  baseProfileId: string;
  modelId: string;
  revision: string;
  tokenizerRevision: string;
  chatTemplateHash: string;
};

export const MANAGED_RL_BASE_PROFILE = {
  baseProfileId: "qwen3-0-6b-c1899de2",
  modelId: "Qwen/Qwen3-0.6B",
  revision: "c1899de289a04d12100db370d81485cdf75e47ca",
  tokenizerRevision: "c1899de289a04d12100db370d81485cdf75e47ca",
  chatTemplateHash: "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
} as const satisfies ManagedRlBaseProfile;

export function managedRlBaseProfileForModel(modelId: string): ManagedRlBaseProfile | null {
  return MANAGED_RL_BASE_PROFILE.modelId === modelId ? MANAGED_RL_BASE_PROFILE : null;
}

export function resolveManagedRlBaseProfile(
  preference: BaseModelPreference | null | undefined,
): ManagedRlBaseProfile | null {
  if (!preference) return null;
  const profile = MANAGED_RL_BASE_PROFILE;
  return preference.modelId === profile.modelId &&
    preference.revision === profile.revision &&
    preference.tokenizerRevision === profile.tokenizerRevision &&
    preference.chatTemplateHash === profile.chatTemplateHash
    ? profile
    : null;
}
