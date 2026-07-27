import {
  ResolvedTrainingPlanSchema,
  TrainingPlanSchema,
  TrainingRecipeSchema,
  type MarketingBenchmarkSpecification,
  type ModelRunDraft,
  type Taskset,
  type TrainingApproval,
} from "@openpond/contracts";
import {
  createTrainingPlan as createSdkTrainingPlan,
  publishTasksetTrainingGraph,
} from "@openpond/training-sdk";
import { contentHash } from "@openpond/taskset-sdk";

import type { SqliteStore } from "../store/store.js";
import {
  PRIME_GRPO_QWEN3_0_6B_PROFILE,
  resolvePrimeGrpoBaseProfile,
} from "./prime-grpo-base-profiles.js";
import { withAuthoritativeRecipeHashes } from "./training-service-helpers.js";
import { MARKETING_PORTFOLIO_HARNESS_CONTRACT_HASH } from "./marketing-portfolio-constraint-repair.js";

export const PRIME_GRPO_MODEL_ID =
  PRIME_GRPO_QWEN3_0_6B_PROFILE.modelId;
export const PRIME_GRPO_MODEL_REVISION =
  PRIME_GRPO_QWEN3_0_6B_PROFILE.revision;
export const PRIME_GRPO_CHAT_TEMPLATE_HASH =
  PRIME_GRPO_QWEN3_0_6B_PROFILE.chatTemplateHash;
export const PRIME_GRPO_BASE_PROFILE_ID =
  PRIME_GRPO_QWEN3_0_6B_PROFILE.baseProfileId;
export const PRIME_RL_UPSTREAM_REVISION =
  "e0d60e4d85ea636873acb2e7083e794740d20226";
export const PRIME_RL_SOURCE_IMAGE_DIGEST =
  "sha256:eae2df21d34ddfdc0065390b4f3261ff691ea4ebd281630f64aacc60855c0c37";

export type PrimeQuoteCandidate = {
  device: { id: string; name: string };
  hourlyCostUsd: number;
  estimatedCostUsd: number;
  quoteId: string;
  deadline: string;
  durationMs: number;
};

export async function createPrimeGrpoTrainingPlan(input: {
  store: SqliteStore;
  draft: ModelRunDraft;
  taskset: Taskset;
  estimatedCostUsd: number;
  createdAt?: string;
}) {
  const recipe = TrainingRecipeSchema.parse(
    withAuthoritativeRecipeHashes(input.taskset, input.draft.recipe)
  );
  assertPrimeGrpoDraft(input.draft, input.taskset, recipe);
  const specification = await requireMarketingPreregistration({
    store: input.store,
    draft: input.draft,
    taskset: input.taskset,
  });
  const baselineReport = (
    await input.store.listBaselineReports(input.taskset.id)
  ).find(
    (report) => report.id === specification.preregistration.baselineReport.id
  );
  if (
    !baselineReport ||
    contentHash(baselineReport) !==
      specification.preregistration.baselineReport.contentHash ||
    !baselineReport.scope ||
    baselineReport.rftSignal?.passed !== true
  ) {
    throw new Error(
      "Prime GRPO requires the unchanged passing train-signal report from benchmark preregistration."
    );
  }
  const initial = createSdkTrainingPlan({
    modelId: input.draft.modelId,
    taskset: input.taskset,
    destinationId: "prime_hosted",
    recipe,
    exportApproved: true,
    retentionDays: null,
    region: null,
  });
  const createdAt = input.createdAt ?? new Date().toISOString();
  const compatibility = {
    schemaVersion: "openpond.trainingCompatibility.v1" as const,
    compatible: true,
    destinationId: "prime_hosted" as const,
    tasksetId: input.taskset.id,
    recipeMethod: "grpo" as const,
    issues: [],
    checkedAt: createdAt,
  };
  const content = {
    ...initial,
    recipe,
    environmentPlacement: "local" as const,
    compatibility,
    rftSignalGate: {
      baselineReportId: baselineReport.id,
      baselineReportHash: contentHash(baselineReport),
      scope: baselineReport.scope,
      signal: baselineReport.rftSignal,
    },
    estimatedCostUsd: input.estimatedCostUsd,
    createdAt,
    contentHash: "",
  };
  return {
    plan: TrainingPlanSchema.parse({
      ...content,
      contentHash: contentHash(content),
    }),
    specification,
  };
}

export function buildPrimeGrpoReleaseGraph(input: {
  taskset: Taskset;
  draft: ModelRunDraft;
  approval: TrainingApproval;
  deviceOrPool: string;
  computeCapabilityReceipt: string;
  engineCapabilityReceipt: string;
  openpondRelease: string;
  releasePublishedAt?: string;
}) {
  return publishTasksetTrainingGraph({
    taskset: input.taskset,
    modelRun: input.draft,
    runtime: {
      adapterId: "local-harness",
      placement: "local",
      capabilityReceipt: contentHash({
        runtime: "openpond-marketing-portfolio-harness",
        tasksetHash: input.taskset.contentHash,
        policyHarnessContractHash: MARKETING_PORTFOLIO_HARNESS_CONTRACT_HASH,
      }),
      runtimeVersion: input.openpondRelease,
      dataPlane: null,
    },
    compute: {
      adapterId: "prime-raw",
      kind: "managed",
      deviceOrPool: input.deviceOrPool,
      capabilityReceipt: input.computeCapabilityReceipt,
      provider: "prime",
    },
    engine: {
      adapterId: "connected-prime-rl",
      workerVersion: input.openpondRelease,
      workerImageDigest: PRIME_RL_SOURCE_IMAGE_DIGEST,
      upstreamRevision: PRIME_RL_UPSTREAM_REVISION,
      capabilityReceipt: input.engineCapabilityReceipt,
    },
    approval: {
      approvalHash: contentHash(input.approval),
      approvedAt: input.approval.approvedAt,
      maximumSpendUsd: input.approval.maximumCostUsd,
    },
    openpondRelease: input.openpondRelease,
    workerProtocol: "openpond.groupedGrpoAssignment.v1",
    releasePublishedAt: input.releasePublishedAt,
  });
}

export function resolvePrimeGrpoPlan(input: {
  graph: ReturnType<typeof buildPrimeGrpoReleaseGraph>;
  recipe: ModelRunDraft["recipe"];
  approval: TrainingApproval;
}) {
  if (!input.recipe) {
    throw new Error("Prime GRPO Recipe is unavailable.");
  }
  const core = {
    schemaVersion: "openpond.resolvedTrainingPlan.v1" as const,
    manifest: input.graph.manifest,
    recipe: input.recipe,
    runtime: input.graph.manifest.runtimeTarget,
    compute: input.graph.manifest.computeTarget,
    engine: input.graph.manifest.engine,
    maximumSpendUsd: input.approval.maximumCostUsd,
    approvalHash: contentHash(input.approval),
  };
  return ResolvedTrainingPlanSchema.parse({
    ...core,
    contentHash: contentHash(core),
  });
}

export function choosePrimeGrpoQuote(input: {
  devices: Array<{ id: string; name: string }>;
  hourlyQuotes: Map<
    string,
    {
      quoteId: string;
      hourlyCostUsd: number;
    }
  >;
  walletBalanceUsd: number;
  now: Date;
  minimumDurationMs?: number;
  targetDurationMs?: number;
  excludedDeviceIds?: ReadonlySet<string>;
}): PrimeQuoteCandidate {
  const minimumDurationMs = input.minimumDurationMs ?? 20 * 60_000;
  const targetDurationMs = input.targetDurationMs ?? 45 * 60_000;
  const candidates = input.devices.flatMap((device) => {
    const quote = input.hourlyQuotes.get(device.id);
    if (!quote || quote.hourlyCostUsd <= 0) return [];
    const affordableDurationMs = Math.floor(
      (input.walletBalanceUsd / quote.hourlyCostUsd) * 3_600_000
    );
    const durationMs = Math.min(targetDurationMs, affordableDurationMs);
    if (durationMs < minimumDurationMs) return [];
    const estimatedCostUsd = roundUsd(
      (quote.hourlyCostUsd * durationMs) / 3_600_000
    );
    return [
      {
        device,
        hourlyCostUsd: quote.hourlyCostUsd,
        estimatedCostUsd,
        quoteId: quote.quoteId,
        deadline: new Date(input.now.getTime() + durationMs).toISOString(),
        durationMs,
      },
    ];
  });
  const eligibleCandidates = input.excludedDeviceIds?.size
    ? candidates.filter(
      (candidate) => !input.excludedDeviceIds!.has(candidate.device.id)
    )
    : candidates;
  if (candidates.length > 0 && eligibleCandidates.length === 0) {
    throw new Error(
      "All currently affordable Prime H100 offerings failed provisioning within the retry cooldown."
    );
  }
  eligibleCandidates.sort(
    (left, right) =>
      left.estimatedCostUsd - right.estimatedCostUsd ||
      left.hourlyCostUsd - right.hourlyCostUsd ||
      left.device.id.localeCompare(right.device.id)
  );
  const selected = eligibleCandidates[0];
  if (!selected) {
    throw new Error(
      "The available Prime wallet balance cannot cover the minimum 20-minute grouped-GRPO run."
    );
  }
  return selected;
}

async function requireMarketingPreregistration(input: {
  store: SqliteStore;
  draft: ModelRunDraft;
  taskset: Taskset;
}): Promise<MarketingBenchmarkSpecification> {
  const baseProfile = resolvePrimeGrpoBaseProfile(
    input.draft.baseModel,
  );
  if (!baseProfile) {
    throw new Error(
      "Prime GRPO requires an exact qualified Qwen3 base profile.",
    );
  }
  const specification = (
    await input.store.listMarketingBenchmarkSpecifications({
      tasksetId: input.taskset.id,
    })
  ).find(
    (candidate) =>
      candidate.arms[0]?.baseRepository === baseProfile.modelId &&
      candidate.arms[0]?.baseRevision === baseProfile.revision,
  );
  if (
    !specification ||
    specification.profileId !== input.draft.profileId ||
    specification.taskset.revision !== input.taskset.revision ||
    specification.taskset.contentHash !== input.taskset.contentHash ||
    specification.preregistration.rftSignalPassed !== true ||
    specification.preregistration.thresholdsLockedBeforeTraining !== true
  ) {
    throw new Error(
      "Prime GRPO requires the immutable 96-attempt marketing benchmark preregistration before training."
    );
  }
  return specification;
}

function assertPrimeGrpoDraft(
  draft: ModelRunDraft,
  taskset: Taskset,
  recipe: ReturnType<typeof TrainingRecipeSchema.parse>
): void {
  const baseProfile = resolvePrimeGrpoBaseProfile(draft.baseModel);
  if (
    draft.status !== "ready_to_run" ||
    draft.destinationId !== "prime_hosted" ||
    draft.method !== "grpo" ||
    recipe.method !== "grpo" ||
    draft.tasksetRef?.id !== taskset.id ||
    draft.tasksetRef.revision !== taskset.revision ||
    draft.tasksetRef.contentHash !== taskset.contentHash ||
    !taskset.readiness?.ready ||
    !baseProfile ||
    recipe.baseModel.id !== baseProfile.modelId ||
    recipe.baseModel.revision !== baseProfile.revision ||
    recipe.baseModel.tokenizerRevision !== baseProfile.tokenizerRevision ||
    recipe.baseModel.chatTemplateHash !== baseProfile.chatTemplateHash ||
    !recipe.policyOptimization ||
    recipe.loss.method !== "grpo" ||
    recipe.loss.klBeta !== null
  ) {
    throw new Error(
      "Saved Model Run is not an exact ready qualified Qwen3 LoRA GRPO plan."
    );
  }
}

function roundUsd(value: number): number {
  return Math.ceil(value * 1_000_000) / 1_000_000;
}
