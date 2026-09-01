import path from "node:path";
import {
  TrainingApprovalSchema,
  TrainingPreparedStartSchema,
  TrainingPlanSchema,
  TrainingRecipeSchema,
  type TrainingDestinationId,
  type ImmutableReleaseRef,
  type ModelComparisonEntryRef,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import {
  type TrainingDestinationRegistry,
  buildTrainingBundle,
  createTrainingPlan,
  validateTrainingBundle,
} from "@openpond/training-sdk";
import type { SqliteStore } from "../store/store.js";
import {
  type createTrainingDatasetSelection,
  toProjectedTrainingData,
} from "./training-dataset-selection.js";
import { withAuthoritativeRecipeHashes } from "./training-service-helpers.js";
import { assertTasksetExecutableForTraining } from "./training-execution-readiness.js";

export type TrainingStartInput = {
  modelId: string;
  tasksetId: string;
  destinationId: TrainingDestinationId;
  recipe: unknown;
  environmentPlacement?: "local" | "remote";
  exportApproved?: boolean;
  maximumCostUsd?: number | null;
  retentionDays?: number | null;
  region?: string | null;
  harnessRelease?: ImmutableReleaseRef | null;
  modelImprovementQualification?: ImmutableReleaseRef | null;
  comparisonSeriesEntry?: ModelComparisonEntryRef | null;
};

export function createTrainingPlanLifecycleService(deps: {
  store: SqliteStore;
  storeDir: string;
  registry: TrainingDestinationRegistry;
  projectArtifactRows: ReturnType<
    typeof createTrainingDatasetSelection
  >["projectArtifactRows"];
  revalidateCompute?: () => Promise<void>;
}) {
  async function createPlan(
    input: Omit<TrainingStartInput, "maximumCostUsd">,
  ) {
    const taskset = await deps.store.getTaskset(input.tasksetId);
    if (!taskset) throw new Error("Taskset not found.");
    assertTasksetExecutableForTraining(taskset);
    const recipe = TrainingRecipeSchema.parse(
      withAuthoritativeRecipeHashes(taskset, input.recipe),
    );
    const destination = deps.registry.get(input.destinationId);
    const capabilities = await destination.capabilities();
    const initial = createTrainingPlan({
      modelId: input.modelId,
      taskset,
      destinationId: input.destinationId,
      recipe,
      environmentPlacement: input.environmentPlacement,
      exportApproved: input.exportApproved,
      retentionDays: input.retentionDays,
      region: input.region,
      harnessRelease: input.harnessRelease,
      modelImprovementQualification: input.modelImprovementQualification,
    });
    const requestedPlacement =
      input.environmentPlacement ?? initial.environmentPlacement;
    const environmentPlacement =
      capabilities.environmentPlacements.includes(requestedPlacement)
        ? requestedPlacement
        : recipe.method === "ppo"
          && capabilities.environmentPlacements.includes("local")
          ? "local"
          : capabilities.environmentPlacements[0] ?? "none";
    const draft = TrainingPlanSchema.parse({
      ...initial,
      environmentPlacement,
      comparisonSeriesEntry: input.comparisonSeriesEntry ?? null,
    });
    const compatibility = await destination.validate(draft);
    const quote = compatibility.compatible
      ? await destination.quote(draft)
      : { estimatedCostUsd: null };
    const planInput = {
      ...draft,
      compatibility,
      estimatedCostUsd: quote.estimatedCostUsd,
      contentHash: "",
    };
    const plan = TrainingPlanSchema.parse({
      ...planInput,
      contentHash: contentHash(planInput),
    });
    await deps.store.saveTrainingPlan(plan);
    return plan;
  }

  async function buildBundle(planId: string) {
    const plan = await deps.store.getTrainingPlan(planId);
    if (!plan) throw new Error("Training Plan not found.");
    const taskset = await deps.store.getTaskset(plan.tasksetId);
    if (!taskset) throw new Error("Taskset not found.");
    const directory = path.join(
      deps.storeDir,
      "training",
      "bundles",
      plan.id,
    );
    const projected = taskset.datasetArtifact
      ? await deps.projectArtifactRows(taskset, plan, "train")
      : null;
    const manifest = await buildTrainingBundle({
      taskset,
      plan,
      directory,
      projectedTrainingData: toProjectedTrainingData(projected),
    });
    const validation = await validateTrainingBundle(directory);
    if (!validation.valid) {
      throw new Error(
        `Training Bundle validation failed: ${validation.issues.join("; ")}`,
      );
    }
    await deps.store.saveTrainingBundle(manifest);
    return { manifest, directory, validation };
  }

  async function approve(input: {
    planId: string;
    bundleId: string;
    approvedBy?: string;
    maximumCostUsd?: number | null;
  }) {
    const plan = await deps.store.getTrainingPlan(input.planId);
    const bundle = await deps.store.getTrainingBundle(input.bundleId);
    if (!plan || !bundle || bundle.planId !== plan.id) {
      throw new Error("Training Plan and Bundle do not match.");
    }
    if (!plan.compatibility.compatible) {
      throw new Error("Incompatible Training Plans cannot be approved.");
    }
    const recipe = TrainingRecipeSchema.parse(plan.recipe);
    if (
      recipe.method !== "sft"
      && recipe.method !== "dpo"
      && recipe.method !== "grpo"
      && recipe.method !== "ppo"
    ) {
      throw new Error(
        `Training method ${recipe.method} has no executable approval contract.`,
      );
    }
    const approvedBy = input.approvedBy ?? "local_user";
    const maximumCostUsd = input.maximumCostUsd ?? plan.estimatedCostUsd;
    const approvalModel = recipe.method === "dpo"
      ? recipe.policyModel
      : recipe.method === "ppo"
        ? recipe.policyOptimization.policyModel
        : recipe.baseModel;
    const approvalId = `training_approval_${contentHash([
      plan.id,
      bundle.contentHash,
      plan.destinationId,
      approvalModel.id,
      recipe.method,
      recipe.parameterization,
      plan.modelImprovementQualification,
      maximumCostUsd,
      approvedBy,
    ]).slice(0, 24)}`;
    const existing = await deps.store.getTrainingApproval(approvalId);
    if (existing) return existing;
    const approval = TrainingApprovalSchema.parse({
      schemaVersion: "openpond.trainingApproval.v1",
      id: approvalId,
      planId: plan.id,
      bundleHash: bundle.contentHash,
      destinationId: plan.destinationId,
      modelId: approvalModel.id,
      method: recipe.method,
      parameterization: recipe.parameterization,
      maximumCostUsd,
      approvedBy,
      approvedAt: new Date().toISOString(),
      harnessRelease: plan.harnessRelease,
      modelImprovementQualification: plan.modelImprovementQualification,
    });
    return deps.store.saveTrainingApproval(approval);
  }

  async function launch(input: { planId: string; approvalId: string }) {
    const plan = await deps.store.getTrainingPlan(input.planId);
    const approval = await deps.store.getTrainingApproval(input.approvalId);
    if (
      !plan
      || !approval
      || approval.planId !== plan.id
      || approval.destinationId !== plan.destinationId
    ) {
      throw new Error("Training approval does not match this plan.");
    }
    const bundle = await deps.store.findTrainingBundleByPlanAndHash(
      plan.id,
      approval.bundleHash,
    );
    if (!bundle) throw new Error("Approved Training Bundle was not found.");
    const existing = (await deps.store.listTrainingJobs()).find(
      (job) => job.approvalId === approval.id,
    );
    if (existing) {
      try {
        return await deps.registry
          .get(existing.destinationId)
          .status(existing.id);
      } catch {
        return existing;
      }
    }
    const job = await deps.registry
      .get(plan.destinationId)
      .launch(plan, approval);
    await deps.store.saveTrainingJob(job);
    return job;
  }

  async function start(input: TrainingStartInput) {
    await deps.revalidateCompute?.();
    const plan = await createPlan(input);
    const bundle = await buildBundle(plan.id);
    const approval = await approve({
      planId: plan.id,
      bundleId: bundle.manifest.id,
      maximumCostUsd: input.maximumCostUsd,
    });
    await deps.revalidateCompute?.();
    const job = await launch({
      planId: plan.id,
      approvalId: approval.id,
    });
    return { plan, bundle: bundle.manifest, approval, job };
  }

  async function prepareStart(
    input: Omit<TrainingStartInput, "maximumCostUsd">,
  ) {
    await deps.revalidateCompute?.();
    const plan = await createPlan(input);
    if (!plan.compatibility.compatible) {
      throw new Error(
        "Training preparation did not produce a compatible plan.",
      );
    }
    const bundle = await buildBundle(plan.id);
    const approvalActor = null;
    return TrainingPreparedStartSchema.parse({
      schemaVersion: "openpond.trainingPreparedStart.v1",
      plan,
      bundle: bundle.manifest,
      approvalActor,
      preparedAt: new Date().toISOString(),
    });
  }

  async function startPrepared(input: {
    planId: string;
    bundleId: string;
    maximumCostUsd: number | null;
  }) {
    await deps.revalidateCompute?.();
    const plan = await deps.store.getTrainingPlan(input.planId);
    const bundle = await deps.store.getTrainingBundle(input.bundleId);
    if (!plan || !bundle || bundle.planId !== plan.id) {
      throw new Error("Prepared Training Plan and Bundle do not match.");
    }
    const taskset = await deps.store.getTaskset(plan.tasksetId);
    if (!taskset || taskset.contentHash !== plan.tasksetHash) {
      throw new Error(
        "The prepared Training Plan is stale. Prepare a new quote from the current Taskset.",
      );
    }
    assertTasksetExecutableForTraining(taskset);
    const approval = await approve({
      planId: plan.id,
      bundleId: bundle.id,
      maximumCostUsd: input.maximumCostUsd,
    });
    await deps.revalidateCompute?.();
    const job = await launch({
      planId: plan.id,
      approvalId: approval.id,
    });
    return { plan, bundle, approval, job };
  }

  return {
    createPlan,
    buildBundle,
    approve,
    launch,
    start,
    prepareStart,
    startPrepared,
  };
}
