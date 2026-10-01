import { ModelRunSchema } from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import { verifyAdvancedRefinerEvaluationPin } from "openpond-sdk/advanced-refiner-evaluations";
import { forkLocalHarnessWorkspaceFromRelease } from "../harness/local-harness-workspace-service.js";
import { resolveSelectedLocalHarnessRelease } from "../harness/local-harness-selection.js";
import {
  createHarnessRefinerExecutionPlan,
  totalPlannedAttempts,
} from "./harness-refiner-benchmark-protocol.js";
import {
  requireModelProject,
  modelVersionId,
  emptyEvaluationAccounting,
} from "./harness-refiner-benchmark-service-support.js";
import type {
  createHarnessRefinerBenchmarkService,
  StartBenchmarkInput,
} from "./harness-refiner-benchmark-service.js";
/** The actual Run owns immutable source, population and policy admission. */
export async function prepareHarnessRefinerBenchmarkAdmission(
  deps: Parameters<typeof createHarnessRefinerBenchmarkService>[0],
  input: StartBenchmarkInput,
  now: () => string,
) {
  if (!Number.isFinite(input.maximumSpendUsd) || input.maximumSpendUsd <= 0) {
    throw new Error(
      "Harness Refiner benchmark maximum spend must be greater than zero.",
    );
  }
  const project = deps.resolveEvaluationProject?await deps.resolveEvaluationProject(input.modelId,input.profileId):await requireModelProject(deps.store,input.modelId,input.profileId);
  if(project.id!==input.modelId||project.profileId!==input.profileId)throw new Error("The actual evaluation configuration owner changed.");
  const advanced = input.advancedEvaluation
    ? verifyAdvancedRefinerEvaluationPin(input.advancedEvaluation)
    : null;
  if (advanced) {
    if (!deps.advancedBoundary || !input.selectedTaskset)
      throw new Error(
        "The advanced evaluation owner and exact selected Dataset adapter are unavailable.",
      );
    await deps.advancedBoundary.authorize(advanced);
    if (
      advanced.profileRef.profileId !== input.profileId ||
      advanced.maximumCostUsd !== input.maximumSpendUsd
    )
      throw new Error(
        "Advanced evaluation changed its admitted source or budget.",
      );
  }
  let taskset = advanced
    ? await deps.store.getTaskset(input.selectedTaskset!.id)
    : await deps.benchmarkTasksets.ensureHarnessRefiner({
        profileId: input.profileId,
      });
  if (!taskset) throw new Error("The exact selected Taskset is unavailable.");
  if (
    advanced &&
    (taskset.revision !== input.selectedTaskset!.revision ||
      taskset.contentHash !== input.selectedTaskset!.contentHash ||
      taskset.metadata.importedPackageHash !==
        advanced.externalDatasetBinding.packageHash)
  )
    throw new Error("The advanced selected Dataset package changed.");
  if (!taskset.benchmark)
    throw new Error("Harness Refiner Taskset is unavailable.");
  if (
    taskset.graders.some(
      (grader) =>
        grader.kind === "model_judge" &&
        grader.rewardEligible &&
        grader.calibrationStatus !== "passed",
    )
  ) {
    if (advanced)
      throw new Error(
        "The selected model judge needs its own completed calibration before advanced evaluation.",
      );
    const calibration = await deps.evaluation.calibrateModelJudges(taskset.id);
    if (!calibration.passed) {
      throw new Error(
        "Harness Refiner model judge did not pass its declared calibration fixtures.",
      );
    }
    taskset = calibration.taskset;
  }
  const executionPlan = createHarnessRefinerExecutionPlan({
    taskset,
    seeds: input.seeds,
    repetitions: input.repetitions,
    ...(advanced ? { selectedPopulation: advanced } : {}),
  });
  const selectedHarness = advanced
    ? await deps.store.getHarnessReleaseRecord(
        advanced.baselineRelease.contentHash,
      )
    : await resolveSelectedLocalHarnessRelease(deps.store);
  if (
    advanced &&
    selectedHarness?.harnessRelease.id !== advanced.baselineRelease.id
  )
    throw new Error("The admitted baseline source release is unavailable.");
  if (!selectedHarness)
    throw new Error("A selected local Harness is required.");
  const upstreamModel = await deps.resolveUpstreamModel(input.model);
  const startedAt = now();
  const id = advanced
    ? `advanced-refiner-${contentHash([advanced.actorId, advanced.teamId, advanced.operationId, advanced.contentHash, input.model, input.seeds, input.repetitions]).slice(0, 40)}`
    : `model_run_${contentHash({
        modelId: project.id,
        taskset: taskset.contentHash,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        seeds: input.seeds,
        repetitions: input.repetitions,
        startedAt,
      }).slice(0, 24)}`;
  if (advanced) {
    const prior = await deps.store.getModelRun(id);
    if (prior) {
      if (
        prior.evaluation?.benchmarkId !== "harness-refiner" ||
        prior.evaluation.advancedEvaluation?.contentHash !==
          advanced.contentHash
      )
        throw new Error(
          "The advanced operation retains another immutable intent.",
        );
      return { prepared: prior, project, existing: true };
    }
  }
  const isolated = await forkLocalHarnessWorkspaceFromRelease({
    store: deps.store,
    storeDir: deps.storeDir,
    id: `benchmark-${id}`,
    ownerId: `benchmark:${id}`,
    name: `Harness Refiner ${id}`,
    sourceRelease: {
      id: selectedHarness.harnessRelease.id,
      contentHash: selectedHarness.harnessRelease.contentHash,
    },
    now,
  });
  await deps.store.setHarnessBackgroundReviewSettings({
    workspaceId: isolated.workspace.id,
    enabled: false,
    updatedAt: now(),
  });
  const versionId = modelVersionId(project.id);
  const prepared = await deps.store.saveModelRun(
    ModelRunSchema.parse({
      schemaVersion: "openpond.modelRun.v1",
      id,
      modelId: project.id,
      modelVersionId: versionId,
      profileId: input.profileId,
      kind: "evaluation",
      status: "running",
      method: null,
      destinationId: null,
      taskset: {
        id: taskset.id,
        revision: taskset.revision,
        contentHash: taskset.contentHash,
      },
      harnessRelease: {
        id: isolated.release.harnessRelease.id,
        contentHash: isolated.release.harnessRelease.contentHash,
      },
      quote: null,
      evaluation: {
        benchmarkId: "harness-refiner",
        ...(advanced ? { advancedEvaluation: advanced } : {}),
        model: input.model,
        upstreamModel,
        reasoningEffort: input.reasoningEffort,
        seeds: input.seeds,
        repetitions: input.repetitions,
        maximumSpendUsd: input.maximumSpendUsd,
        attemptPlan: executionPlan,
      },
      evaluationProgress: {
        stage: "adaptation",
        completedAttempts: 0,
        totalAttempts: totalPlannedAttempts(executionPlan),
        accounting: emptyEvaluationAccounting(),
      },
      reward: null,
      receipt: null,
      adapterArtifactLineageId: null,
      failure: null,
      startedAt,
      completedAt: null,
      updatedAt: startedAt,
    }),
  );
  return { prepared, project, existing: false };
}
