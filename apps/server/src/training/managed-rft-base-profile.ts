import type { BaseModelPreference } from "@openpond/contracts";

export type ManagedRftBaseProfile = {
  baseProfileId: string;
  modelId: string;
  revision: string;
  tokenizerRevision: string;
  chatTemplateHash: string;
};

export const MANAGED_RFT_BASE_PROFILE = {
  baseProfileId: "qwen3-0-6b-c1899de2",
  modelId: "Qwen/Qwen3-0.6B",
  revision: "c1899de289a04d12100db370d81485cdf75e47ca",
  tokenizerRevision: "c1899de289a04d12100db370d81485cdf75e47ca",
  chatTemplateHash:
    "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
} as const satisfies ManagedRftBaseProfile;

export function managedRftBaseProfileForModel(
  modelId: string,
): ManagedRftBaseProfile | null {
  return MANAGED_RFT_BASE_PROFILE.modelId === modelId
    ? MANAGED_RFT_BASE_PROFILE
    : null;
}

export function resolveManagedRftBaseProfile(
  preference: BaseModelPreference | null | undefined,
): ManagedRftBaseProfile | null {
  if (!preference) return null;
  const profile = MANAGED_RFT_BASE_PROFILE;
  return preference.modelId === profile.modelId &&
      preference.revision === profile.revision &&
      preference.tokenizerRevision === profile.tokenizerRevision &&
      preference.chatTemplateHash === profile.chatTemplateHash
    ? profile
    : null;
}
