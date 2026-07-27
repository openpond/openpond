import type { BaseModelPreference } from "@openpond/contracts";

export type PrimeGrpoBaseProfile = {
  baseProfileId: string;
  modelId: string;
  revision: string;
  tokenizerRevision: string;
  chatTemplateHash: string;
};

export const PRIME_GRPO_QWEN3_0_6B_PROFILE = {
  baseProfileId: "qwen3-0-6b-c1899de2",
  modelId: "Qwen/Qwen3-0.6B",
  revision: "c1899de289a04d12100db370d81485cdf75e47ca",
  tokenizerRevision: "c1899de289a04d12100db370d81485cdf75e47ca",
  chatTemplateHash:
    "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
} as const satisfies PrimeGrpoBaseProfile;

export const PRIME_GRPO_QWEN3_8B_PROFILE = {
  baseProfileId: "qwen3-8b-b968826d",
  modelId: "Qwen/Qwen3-8B",
  revision: "b968826d9c46dd6066d109eabc6255188de91218",
  tokenizerRevision: "b968826d9c46dd6066d109eabc6255188de91218",
  chatTemplateHash:
    "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
} as const satisfies PrimeGrpoBaseProfile;

export const PRIME_GRPO_BASE_PROFILES = [
  PRIME_GRPO_QWEN3_0_6B_PROFILE,
  PRIME_GRPO_QWEN3_8B_PROFILE,
] as const satisfies readonly PrimeGrpoBaseProfile[];

export function primeGrpoBaseProfileForModel(
  modelId: string,
): PrimeGrpoBaseProfile | null {
  return (
    PRIME_GRPO_BASE_PROFILES.find(
      (profile) => profile.modelId === modelId,
    ) ?? null
  );
}

export function resolvePrimeGrpoBaseProfile(
  preference: BaseModelPreference | null | undefined,
): PrimeGrpoBaseProfile | null {
  if (!preference) return null;
  return (
    PRIME_GRPO_BASE_PROFILES.find(
      (profile) =>
        preference.modelId === profile.modelId &&
        preference.revision === profile.revision &&
        preference.tokenizerRevision === profile.tokenizerRevision &&
        preference.chatTemplateHash === profile.chatTemplateHash,
    ) ?? null
  );
}
