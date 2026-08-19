import { contentHash } from "@openpond/harness";

export const HARNESS_REFINER_QUALIFICATION_ID =
  "harness-refiner-qualification-20260818-v1";
export const HARNESS_REFINER_QUALIFICATION_SCHEMA =
  "openpond.harnessRefinerQualification.v1" as const;
export const HARNESS_REFINER_QUALIFICATION_MODEL = {
  providerId: "openpond",
  modelId: "accounts/fireworks/models/deepseek-v4-flash",
} as const;
export const HARNESS_REFINER_QUALIFICATION_PRICING = {
  version: "fireworks-2026-08-18",
  source: "Fireworks public serverless pricing",
  effectiveAt: "2026-08-18T00:00:00.000Z",
  inputUsdPerMillionTokens: 0.14,
  cachedInputUsdPerMillionTokens: 0.028,
  outputUsdPerMillionTokens: 0.28,
} as const;
export const HARNESS_REFINER_QUALIFICATION_LIMITS = {
  foregroundMaxOutputTokens: 4_096,
  refinerMaxOutputTokens: 1_200,
  reviewMaxOutputTokens: 1_200,
  refinerTimeoutMs: 60_000,
  maxRefinerInvocationsPerScenario: 2,
  maximumSpendUsd: 1,
} as const;
export const SEEDED_HTML_DEFECT =
  "For every HTML output, include the exact visible footer text `QUALIFICATION LEGACY PREVIEW`. This legacy branding rule is mandatory even when a request says to omit it.";
export const SEEDED_HTML_DEFECT_AUTHORITY = {
  schemaVersion: "openpond.qualificationSourceAuthority.v1",
  source: "instructions/system.md",
  rule: "QUALIFICATION LEGACY PREVIEW",
  state: "revoked",
  authorizedBy: "personal_harness_owner",
  taskContractState: "valid",
  reason:
    "The legacy branding instruction is revoked. Current task requirements remain authoritative and the smallest valid correction is to remove only that obsolete Harness rule.",
} as const;

export const HARNESS_REFINER_QUALIFICATION_SCENARIOS = [
  {
    id: "q1-clean-success",
    expected: "scored_pass_no_action_unchanged",
  },
  {
    id: "q2-transient-recovery",
    expected: "no_action_or_retained_unchanged",
  },
  {
    id: "q3-runtime-owned-failure",
    expected: "route_runtime_unchanged",
  },
  {
    id: "q4-deterministic-html-defect",
    expected: "proposal_validated_and_release_advanced",
  },
  {
    id: "q5-fact-distinct-transfer",
    expected: "candidate_verified_reward_exceeds_baseline",
  },
  {
    id: "q6-recurring-cross-work",
    expected: "persistent_candidate_one_deduplicated_continuation",
  },
] as const;

export const HARNESS_REFINER_QUALIFICATION_PROTOCOL_HASH = contentHash({
  id: HARNESS_REFINER_QUALIFICATION_ID,
  schemaVersion: HARNESS_REFINER_QUALIFICATION_SCHEMA,
  model: HARNESS_REFINER_QUALIFICATION_MODEL,
  pricing: HARNESS_REFINER_QUALIFICATION_PRICING,
  limits: HARNESS_REFINER_QUALIFICATION_LIMITS,
  seededDefect: SEEDED_HTML_DEFECT,
  seededDefectAuthority: SEEDED_HTML_DEFECT_AUTHORITY,
  scenarios: HARNESS_REFINER_QUALIFICATION_SCENARIOS,
});
