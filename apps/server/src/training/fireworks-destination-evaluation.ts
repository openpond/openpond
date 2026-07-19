import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  TaskAttemptResultSchema,
  TrainingArtifactSchema,
  type TaskAttemptResult,
  type Taskset,
  type TrainingArtifact,
  type TrainingJob,
  type TrainingPlan,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import { runTrainingTasksetAttempt } from "./task-baseline-attempt-runner.js";
import {
  FireworksApiClient,
  resourceId,
} from "./fireworks-client.js";
import { FireworksDestinationBase } from "./fireworks-destination-base.js";
import {
  assertBoundedEvaluationDeployment,
  executableBaseRecipe,
  frozenEvaluationAttemptId,
  retryFireworksInference,
  selectFireworksEvaluationAccelerator,
  selectFireworksTrainedServingMode,
  unloadEvaluationLoras,
  waitForEvaluationDeployment,
  waitForEvaluationLora,
  withFireworksEvaluationExecutionLock,
  type FireworksEvaluationDeploymentReceipt,
} from "./fireworks-evaluation-runtime.js";
import {
  errorMessage,
  metadataNumber,
  metadataString,
  providerId,
} from "./fireworks-provider-utils.js";

const FIREWORKS_MINIMUM_TRAINED_PASS_RATE = 0.75;
const FIREWORKS_MINIMUM_ABSOLUTE_PASS_RATE_GAIN = 0.1;
const FIREWORKS_FROZEN_EVALUATION_RUNTIME_VERSION =
  "fireworks-dedicated-cross-system-harness-v2";
const FIREWORKS_FROZEN_EVALUATION_MAX_RUNTIME_MS = 10 * 60_000;
const FIREWORKS_FROZEN_EVALUATION_MAX_GPU_HOURLY_USD = 7;
const FIREWORKS_FROZEN_EVALUATION_MAX_ACCELERATOR_COUNT = 1;

export class FireworksDestinationEvaluation extends FireworksDestinationBase {
  protected async evaluateFrozen(input: {
    job: TrainingJob;
    plan: TrainingPlan;
    taskset: Taskset;
    client: FireworksApiClient;
    baseModel: string;
    trainedModel: string;
  }): Promise<TrainingArtifact | null> {
    const priorArtifactIds = new Set(
      (await this.deps.store.listTrainingArtifacts(input.job.id))
        .filter((artifact) => artifact.kind === "evaluation")
        .map((artifact) => artifact.id),
    );
    return withFireworksEvaluationExecutionLock({
      directory: path.join(
        this.deps.storeDir,
        "training",
        "fireworks",
        metadataString(input.job, "providerJobId"),
      ),
      jobId: input.job.id,
      maxRuntimeMs: FIREWORKS_FROZEN_EVALUATION_MAX_RUNTIME_MS,
      execute: () => this.evaluateFrozenUnlocked(input),
      readCompleted: async () => {
        const artifacts = (await this.deps.store.listTrainingArtifacts(input.job.id))
          .filter((artifact) =>
            artifact.kind === "evaluation" &&
            !priorArtifactIds.has(artifact.id))
          .sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt));
        return artifacts[0] ?? null;
      },
    });
  }

  protected async evaluateFrozenUnlocked(input: {
    job: TrainingJob;
    plan: TrainingPlan;
    taskset: Taskset;
    client: FireworksApiClient;
    baseModel: string;
    trainedModel: string;
  }): Promise<TrainingArtifact | null> {
    if (!this.deps.gradeAttempt) return null;
    const frozen = input.taskset.tasks.filter((task) => task.split === "frozen_eval");
    const results: Array<{
      taskId: string;
      stage: "base" | "trained";
      attemptId: string;
      gradeId: string;
      passed: boolean;
      score: number | null;
      infrastructureError: string | null;
    }> = [];
    const reusableStages: Array<"base" | "trained"> = [];
    const [persistedAttempts, persistedGrades] = await Promise.all([
      this.deps.store.listTaskAttempts(input.taskset.id),
      this.deps.store.listGradeResultsForTaskset(input.taskset.id),
    ]);
    const gradeByAttempt = new Map(
      persistedGrades.map((grade) => [grade.attemptId, grade]),
    );
    for (const stage of ["base", "trained"] as const) {
      const stageAttempts = persistedAttempts.filter(
        (attempt) =>
          attempt.metadata.jobId === input.job.id &&
          attempt.metadata.evaluationStage === stage &&
          attempt.metadata.evaluationRuntimeVersion ===
            FIREWORKS_FROZEN_EVALUATION_RUNTIME_VERSION,
      ).sort((left, right) =>
        left.completedAt.localeCompare(right.completedAt));
      const attemptByTask = new Map(
        stageAttempts.map((attempt) => [attempt.taskId, attempt]),
      );
      const reusable =
        attemptByTask.size === frozen.length &&
        frozen.every((task) => {
          const attempt = attemptByTask.get(task.id);
          return Boolean(
            attempt &&
              attempt.infrastructureError === null &&
              gradeByAttempt.has(attempt.id),
          );
        });
      if (!reusable) continue;
      reusableStages.push(stage);
      for (const task of frozen) {
        const attempt = attemptByTask.get(task.id)!;
        const grade = gradeByAttempt.get(attempt.id)!;
        results.push({
          taskId: task.id,
          stage,
          attemptId: attempt.id,
          gradeId: grade.id,
          passed: grade.passed,
          score: grade.score,
          infrastructureError: null,
        });
      }
    }
    const deployments: FireworksEvaluationDeploymentReceipt[] = [];
    const approvedMaximumCostUsd = metadataNumber(
      input.job,
      "approvedMaximumCostUsd",
    );
    const providerTrainingCostUsd =
      metadataNumber(input.job, "providerEstimatedCostUsd") ?? 0;
    const priorEvaluationArtifacts = (
      await this.deps.store.listTrainingArtifacts(input.job.id)
    ).filter((artifact) => artifact.kind === "evaluation");
    const priorEvaluationCostUsd = priorEvaluationArtifacts
      .reduce(
        (total, artifact) =>
          total +
          (typeof artifact.metadata.estimatedDeploymentCostUsd === "number"
            ? artifact.metadata.estimatedDeploymentCostUsd
            : 0),
        0,
      );
    const unreceiptedEvaluationCostReserveUsd =
      metadataNumber(
        input.job,
        "providerEvaluationUnreceiptedReserveUsd",
      ) ?? 0;
    const nonBillableStartupCorrectionUsd =
      metadataNumber(
        input.job,
        "providerEvaluationNonBillableStartupCorrectionUsd",
      ) ?? 0;
    const evaluationAttemptNumber = priorEvaluationArtifacts.length + 1;
    const evaluationAttemptId = randomUUID();
    const priorDeploymentReceipts = (
      await Promise.all(priorEvaluationArtifacts.map(async (artifact) => {
        try {
          const payload = JSON.parse(await readFile(artifact.path, "utf8")) as {
            deployments?: unknown;
            evaluationAttemptNumber?: unknown;
          };
          return Array.isArray(payload.deployments)
            ? payload.deployments.map((deployment) =>
                deployment &&
                typeof deployment === "object" &&
                !Array.isArray(deployment)
                  ? {
                      ...deployment as Record<string, unknown>,
                      evaluationAttemptNumber:
                        payload.evaluationAttemptNumber,
                    }
                  : deployment)
            : [];
        } catch {
          return [];
        }
      }))
    ).flat();
    if (approvedMaximumCostUsd == null) {
      throw new Error(
        "Fireworks evaluation cannot prove the remaining approved cost boundary.",
      );
    }
    const remainingApprovedCostUsd = Math.max(
      0,
      approvedMaximumCostUsd -
        providerTrainingCostUsd -
        priorEvaluationCostUsd -
        unreceiptedEvaluationCostReserveUsd +
        nonBillableStartupCorrectionUsd,
    );
    const maximumDeploymentCostUsd = Math.min(
      FIREWORKS_FROZEN_EVALUATION_MAX_RUNTIME_MS /
        3_600_000 *
        FIREWORKS_FROZEN_EVALUATION_MAX_GPU_HOURLY_USD,
      remainingApprovedCostUsd,
    );
    if (maximumDeploymentCostUsd <= 0) {
      throw new Error(
        "Fireworks evaluation has no remaining approved provider budget.",
      );
    }
    const maximumRuntimeMs = Math.min(
      FIREWORKS_FROZEN_EVALUATION_MAX_RUNTIME_MS,
      Math.floor(
        maximumDeploymentCostUsd /
          FIREWORKS_FROZEN_EVALUATION_MAX_GPU_HOURLY_USD *
          3_600_000,
      ),
    );
    const deadlineMs = Date.now() + maximumRuntimeMs;
    const accountId = metadataString(input.job, "providerAccountId");
    const maxTokens = Math.min(
      1_024,
      input.plan.recipe.method === "sft"
        ? input.plan.recipe.dataset.maxSequenceLength
        : 1_024,
    );
    const trainedServingMode = selectFireworksTrainedServingMode(
      priorDeploymentReceipts,
      input.job.metadata.fireworksEvaluationServingMode,
    );
    let addonDeploymentShape: string | undefined;
    if (
      !reusableStages.includes("trained") &&
      trainedServingMode === "multi_lora"
    ) {
      try {
        const shapeVersions =
          await input.client.listDeploymentShapeVersions(input.baseModel);
        const desiredAcceleratorType = selectFireworksEvaluationAccelerator(
          priorDeploymentReceipts,
          "trained",
        );
        const compatibleShapes = shapeVersions.filter(
          (version) =>
            version.validated !== false &&
            version.latestValidated === true &&
            version.snapshot?.baseModel === input.baseModel &&
            version.snapshot.precision === "BF16" &&
            version.snapshot.acceleratorCount ===
              FIREWORKS_FROZEN_EVALUATION_MAX_ACCELERATOR_COUNT &&
            (
              version.snapshot.acceleratorType === "NVIDIA_A100_80GB" ||
              version.snapshot.acceleratorType === "NVIDIA_H100_80GB" ||
              version.snapshot.acceleratorType === "NVIDIA_H200_141GB"
            ) &&
            Boolean(version.snapshot.name),
        );
        const addonShape =
          compatibleShapes.find((version) =>
            version.snapshot?.acceleratorType === desiredAcceleratorType) ??
          compatibleShapes[0];
        addonDeploymentShape = addonShape?.snapshot?.name;
      } catch {
        // A named shape is an optimization, not a requirement. Fireworks also
        // supports explicit one-GPU BF16 deployments with addons enabled.
        addonDeploymentShape = undefined;
      }
    }
    const stageSpecs = ([
      { stage: "base", model: input.baseModel },
      { stage: "trained", model: input.trainedModel },
    ] as const)
      .filter((spec) => !reusableStages.includes(spec.stage))
      .map((spec) => {
        const acceleratorType = selectFireworksEvaluationAccelerator(
          priorDeploymentReceipts,
          spec.stage,
        );
        return {
          ...spec,
          acceleratorType,
          servingMode:
            spec.stage === "trained"
              ? trainedServingMode
              : "direct" as const,
          deploymentBaseModel:
            spec.stage === "trained" &&
            trainedServingMode !== "direct"
              ? input.baseModel
              : spec.model,
          precision:
            acceleratorType === "NVIDIA_A100_80GB" ||
            (
              spec.stage === "trained" &&
              trainedServingMode === "multi_lora"
            )
              ? "BF16" as const
              : undefined,
          enableAddons:
            spec.stage === "trained" && trainedServingMode === "multi_lora",
          enableHotReloadLatestAddon:
            spec.stage === "trained" &&
            trainedServingMode === "hot_reload_lora",
          deploymentShape:
            spec.stage === "trained" && trainedServingMode === "multi_lora"
              ? addonDeploymentShape
              : undefined,
          deploymentId: providerId(
            `op-eval-${spec.stage}`,
            `${input.job.id}:${spec.model}:${FIREWORKS_FROZEN_EVALUATION_RUNTIME_VERSION}:${evaluationAttemptId}`,
          ),
        };
      });
    let previewError: string | null = null;
    for (const spec of stageSpecs) {
      try {
        const preview = await input.client.createDeployment({
          accountId,
          deploymentId: spec.deploymentId,
          baseModel: spec.deploymentBaseModel,
          displayName:
            spec.stage === "base" ? "OpenPond base eval" : "OpenPond trained eval",
          description:
            "Temporary bounded deployment for OpenPond frozen evaluation.",
          validateOnly: true,
          acceleratorType: spec.acceleratorType,
          precision: spec.precision,
          enableAddons: spec.enableAddons,
          enableHotReloadLatestAddon: spec.enableHotReloadLatestAddon,
          deploymentShape: spec.deploymentShape,
        });
        assertBoundedEvaluationDeployment(preview, {
          requireAddons: spec.enableAddons,
          requireHotReloadAddon: spec.enableHotReloadLatestAddon,
        });
        deployments.push({
          stage: spec.stage,
          deploymentId: spec.deploymentId,
          model: spec.model,
          deploymentBaseModel: spec.deploymentBaseModel,
          servingMode: spec.servingMode,
          validationOnly: true,
          validationState: preview.state ?? null,
          acceleratorCount: preview.acceleratorCount ?? 1,
          acceleratorType: preview.acceleratorType ?? null,
          precision: preview.precision ?? null,
          enableAddons: preview.enableAddons === true,
          enableHotReloadLatestAddon:
            preview.enableHotReloadLatestAddon === true,
          deploymentShape: preview.deploymentShape ?? null,
          createdAt: null,
          readyAt: null,
          deployedModelId: null,
          addonLoadedAt: null,
          addonUnloadedAt: null,
          addonUnloadStatus:
            spec.servingMode !== "direct"
              ? "not_loaded"
              : "not_applicable",
          deletedAt: null,
          deletionStatus: "not_created",
          error: null,
          durationMs: 0,
          estimatedCostUsd: 0,
        });
      } catch (error) {
        previewError = errorMessage(error);
        deployments.push({
          stage: spec.stage,
          deploymentId: spec.deploymentId,
          model: spec.model,
          deploymentBaseModel: spec.deploymentBaseModel,
          servingMode: spec.servingMode,
          validationOnly: true,
          validationState: null,
          acceleratorCount: 0,
          acceleratorType: null,
          precision: spec.precision ?? null,
          enableAddons: spec.enableAddons,
          enableHotReloadLatestAddon:
            spec.enableHotReloadLatestAddon,
          deploymentShape: null,
          createdAt: null,
          readyAt: null,
          deployedModelId: null,
          addonLoadedAt: null,
          addonUnloadedAt: null,
          addonUnloadStatus:
            spec.servingMode !== "direct"
              ? "not_loaded"
              : "not_applicable",
          deletedAt: null,
          deletionStatus: "not_created",
          error: previewError,
          durationMs: 0,
          estimatedCostUsd: 0,
        });
      }
    }

    const persistAttempt = async (
      stage: "base" | "trained",
      model: string,
      task: (typeof frozen)[number],
      attemptInput: TaskAttemptResult,
    ) => {
      const attempt = TaskAttemptResultSchema.parse({
        ...attemptInput,
        modelRef: { providerId: "fireworks", modelId: model },
        metadata: {
          ...attemptInput.metadata,
          jobId: input.job.id,
          providerJobId: metadataString(input.job, "providerJobId"),
          evaluationAttemptId,
          evaluationAttemptNumber,
          evaluationStage: stage,
          sourceOwnedFrozenEvaluation: true,
          evaluationRuntimeVersion:
            FIREWORKS_FROZEN_EVALUATION_RUNTIME_VERSION,
        },
      });
      await this.deps.store.deleteGradeResultsForAttempt(attempt.id);
      const grade = await this.deps.gradeAttempt!({
        tasksetId: input.taskset.id,
        taskId: task.id,
        attempt,
      });
      results.push({
        taskId: task.id,
        stage,
        attemptId: attempt.id,
        gradeId: grade.id,
        passed: grade.passed,
        score: grade.score,
        infrastructureError: attempt.infrastructureError,
      });
    };

    const persistInfrastructureStage = async (
      stage: "base" | "trained",
      model: string,
      error: string,
    ) => {
      for (const task of frozen) {
        const timestamp = this.timestamp();
        await persistAttempt(
          stage,
          model,
          task,
          TaskAttemptResultSchema.parse({
            schemaVersion: "openpond.taskAttempt.v1",
            id: frozenEvaluationAttemptId(
              input.job.id,
              stage,
              task.id,
              evaluationAttemptId,
            ),
            tasksetId: input.taskset.id,
            taskId: task.id,
            split: "frozen_eval",
            attempt: 0,
            seed: 17,
            modelRef: { providerId: "fireworks", modelId: model },
            startedAt: timestamp,
            completedAt: timestamp,
            output: {},
            runtimeEventRefs: [],
            artifactRefs: [],
            privilegedOutcomeRef: task.privilegedContextRef,
            infrastructureError: error,
            costUsd: null,
            latencyMs: 0,
            userInterventions: 0,
            metadata: {},
          }),
        );
      }
    };

    if (previewError) {
      for (const spec of stageSpecs) {
        await persistInfrastructureStage(
          spec.stage,
          spec.model,
          `Fireworks deployment validation failed before spend: ${previewError}`,
        );
      }
    } else {
      for (const spec of stageSpecs) {
        const previewReceipt = deployments.find(
          (receipt) => receipt.stage === spec.stage,
        )!;
        const receipt: FireworksEvaluationDeploymentReceipt = {
          ...previewReceipt,
          validationOnly: false,
        };
        deployments.splice(deployments.indexOf(previewReceipt), 1, receipt);
        let stageError: string | null = null;
        let deploymentCreated = false;
        let leaseRecorded = false;
        let leaseCreatedAt: string | null = null;
        const startedMs = Date.now();
        try {
          if (startedMs >= deadlineMs) {
            throw new Error(
              "The bounded Fireworks evaluation runtime expired before deployment.",
            );
          }
          leaseCreatedAt = this.timestamp();
          await this.recordEvaluationDeploymentLease({
            jobId: input.job.id,
            accountId,
            deploymentId: spec.deploymentId,
            stage: spec.stage,
            model: spec.model,
            createdAt: leaseCreatedAt,
            expiresAt: new Date(deadlineMs).toISOString(),
          });
          leaseRecorded = true;
          const deployment = await input.client.createDeployment({
            accountId,
            deploymentId: spec.deploymentId,
            baseModel: spec.deploymentBaseModel,
            displayName:
              spec.stage === "base"
                ? "OpenPond base eval"
                : "OpenPond trained eval",
            description:
              "Temporary bounded deployment for OpenPond frozen evaluation.",
            validateOnly: false,
            acceleratorType: spec.acceleratorType,
            precision: spec.precision,
            enableAddons: spec.enableAddons,
            enableHotReloadLatestAddon:
              spec.enableHotReloadLatestAddon,
            deploymentShape: spec.deploymentShape,
          });
          deploymentCreated = true;
          receipt.createdAt = this.timestamp();
          assertBoundedEvaluationDeployment(deployment, {
            requireAddons: spec.enableAddons,
            requireHotReloadAddon: spec.enableHotReloadLatestAddon,
          });
          await waitForEvaluationDeployment({
            client: input.client,
            accountId,
            deploymentId: spec.deploymentId,
            deadlineMs,
            requireAddons: spec.enableAddons,
            requireHotReloadAddon: spec.enableHotReloadLatestAddon,
          });
          receipt.readyAt = this.timestamp();
          const deploymentName =
            `accounts/${accountId}/deployments/${spec.deploymentId}`;
          if (spec.servingMode !== "direct") {
            const deployedModel = await input.client.loadLora({
              accountId,
              model: spec.model,
              deployment: deploymentName,
              displayName: "OpenPond trained eval LoRA",
              description:
                "Temporary LoRA attachment for OpenPond frozen evaluation.",
              replaceMergedAddon:
                spec.servingMode === "hot_reload_lora",
            });
            const deployedModelId = resourceId(deployedModel.name ?? "");
            if (!deployedModelId) {
              throw new Error(
                "Fireworks loaded the evaluation LoRA without returning a deployed model identifier.",
              );
            }
            receipt.deployedModelId = deployedModelId;
            await this.recordEvaluationDeploymentLease({
              jobId: input.job.id,
              accountId,
              deploymentId: spec.deploymentId,
              stage: spec.stage,
              model: spec.model,
              deployedModelId,
              createdAt: leaseCreatedAt,
              expiresAt: new Date(deadlineMs).toISOString(),
            });
            await waitForEvaluationLora({
              client: input.client,
              accountId,
              deployedModelId,
              deadlineMs,
            });
            receipt.addonLoadedAt = this.timestamp();
          }
          const inferenceModel =
            spec.servingMode !== "direct"
              ? `${spec.model}#${deploymentName}`
              : deploymentName;
          const inferenceDeployment =
            spec.servingMode === "direct" ? deploymentName : undefined;
          for (const task of frozen) {
            const providerUsage: unknown[] = [];
            const attempt = await runTrainingTasksetAttempt({
              store: this.deps.store,
              storeDir: this.deps.storeDir,
              resultId: frozenEvaluationAttemptId(
                input.job.id,
                spec.stage,
                task.id,
                evaluationAttemptId,
              ),
              modelText: async (request) => {
                const completion = await retryFireworksInference(
                  () => input.client.chatCompletion({
                    model: inferenceModel,
                    deployment: inferenceDeployment,
                    messages: request.messages,
                    maxTokens,
                    reasoningEffort: "none",
                  }),
                  deadlineMs,
                );
                providerUsage.push(completion.usage);
                return completion.text;
              },
              crossSystemStream: async function* (request) {
                const completion = await retryFireworksInference(
                  () => input.client.chatCompletionWithTools({
                    model: inferenceModel,
                    deployment: inferenceDeployment,
                    messages: request.messages,
                    tools: request.tools,
                    toolChoice: request.toolChoice,
                    maxTokens,
                    reasoningEffort: "none",
                  }),
                  deadlineMs,
                );
                providerUsage.push(completion.usage);
                yield {
                  text: completion.text,
                  toolCalls: completion.toolCalls,
                };
              },
              attemptInput: {
                tasksetId: input.taskset.id,
                task,
                model: {
                  providerId: "fireworks",
                  modelId: spec.model,
                },
                seed: 17,
                attempt: 0,
              },
            });
            await persistAttempt(
              spec.stage,
              spec.model,
              task,
              TaskAttemptResultSchema.parse({
                ...attempt,
                metadata: {
                  ...attempt.metadata,
                  deploymentId: spec.deploymentId,
                  providerUsage,
                },
              }),
            );
          }
        } catch (error) {
          stageError = errorMessage(error);
          if (!deploymentCreated) {
            try {
              const existing = await input.client.deployment(
                accountId,
                spec.deploymentId,
              );
              deploymentCreated =
                existing.state !== "DELETED" &&
                existing.state !== "DELETING";
              if (deploymentCreated) {
                receipt.createdAt = existing.createTime ?? this.timestamp();
              }
            } catch {
              // The provider confirms no readable deployment for this request.
            }
          }
          const completedTaskIds = new Set(
            results
              .filter((result) => result.stage === spec.stage)
              .map((result) => result.taskId),
          );
          for (const task of frozen.filter(
            (candidate) => !completedTaskIds.has(candidate.id),
          )) {
            const timestamp = this.timestamp();
            await persistAttempt(
              spec.stage,
              spec.model,
              task,
              TaskAttemptResultSchema.parse({
                schemaVersion: "openpond.taskAttempt.v1",
                id: frozenEvaluationAttemptId(
                  input.job.id,
                  spec.stage,
                  task.id,
                  evaluationAttemptId,
                ),
                tasksetId: input.taskset.id,
                taskId: task.id,
                split: "frozen_eval",
                attempt: 0,
                seed: 17,
                modelRef: {
                  providerId: "fireworks",
                  modelId: spec.model,
                },
                startedAt: timestamp,
                completedAt: timestamp,
                output: {},
                runtimeEventRefs: [],
                artifactRefs: [],
                privilegedOutcomeRef: task.privilegedContextRef,
                infrastructureError: stageError,
                costUsd: null,
                latencyMs: 0,
                userInterventions: 0,
                metadata: { deploymentId: spec.deploymentId },
              }),
            );
          }
        } finally {
          if (
            deploymentCreated &&
            spec.servingMode !== "direct"
          ) {
            try {
              const unloadedIds = await unloadEvaluationLoras({
                client: input.client,
                accountId,
                deploymentName:
                  `accounts/${accountId}/deployments/${spec.deploymentId}`,
                model: spec.model,
                deployedModelId: receipt.deployedModelId ?? undefined,
              });
              if (unloadedIds.length) {
                receipt.addonUnloadStatus = "unloaded";
                receipt.addonUnloadedAt = this.timestamp();
              }
            } catch (error) {
              receipt.addonUnloadStatus = "failed";
              const unloadError = errorMessage(error);
              receipt.error = receipt.error
                ? `${receipt.error}; LoRA cleanup: ${unloadError}`
                : unloadError;
            }
          }
          if (deploymentCreated) {
            try {
              await input.client.deleteDeployment(accountId, spec.deploymentId);
              receipt.deletionStatus = "deleted";
              receipt.deletedAt = this.timestamp();
            } catch (error) {
              receipt.deletionStatus = "failed";
              const deletionError = errorMessage(error);
              receipt.error = receipt.error
                ? `${receipt.error}; cleanup: ${deletionError}`
                : deletionError;
            }
          }
          receipt.durationMs = Math.max(0, Date.now() - startedMs);
          const billableStartedMs = receipt.readyAt
            ? Date.parse(receipt.readyAt)
            : Number.NaN;
          const billableEndedMs = receipt.deletedAt
            ? Date.parse(receipt.deletedAt)
            : Date.now();
          receipt.estimatedCostUsd =
            deploymentCreated &&
            Number.isFinite(billableStartedMs)
            ? Math.max(0, billableEndedMs - billableStartedMs) /
              3_600_000 *
              Math.max(1, receipt.acceleratorCount) *
              FIREWORKS_FROZEN_EVALUATION_MAX_GPU_HOURLY_USD
            : 0;
          if (stageError) {
            receipt.error = receipt.error
              ? `${stageError}; cleanup: ${receipt.error}`
              : stageError;
          }
          if (
            leaseRecorded &&
            (
              !deploymentCreated ||
              (
                receipt.deletionStatus === "deleted" &&
                receipt.addonUnloadStatus !== "failed"
              )
            )
          ) {
            await this.clearEvaluationDeploymentLease(
              input.job.id,
              spec.deploymentId,
            );
          }
        }
      }
    }
    const basePassed = results.filter((result) => result.stage === "base" && result.passed).length;
    const trainedPassed = results.filter((result) => result.stage === "trained" && result.passed).length;
    const baseInfrastructureFailures = results.filter(
      (result) => result.stage === "base" && result.infrastructureError !== null,
    ).length;
    const trainedInfrastructureFailures = results.filter(
      (result) => result.stage === "trained" && result.infrastructureError !== null,
    ).length;
    const infrastructureFailureCount =
      baseInfrastructureFailures + trainedInfrastructureFailures;
    const deploymentCleanupComplete = deployments.every(
      (deployment) =>
        (
          deployment.deletionStatus === "deleted" ||
          deployment.deletionStatus === "not_created"
        ) &&
        deployment.addonUnloadStatus !== "failed",
    );
    const estimatedDeploymentCostUsd = deployments.reduce(
      (total, deployment) => total + deployment.estimatedCostUsd,
      0,
    );
    const cumulativeEvaluationCostUsd =
      priorEvaluationCostUsd + estimatedDeploymentCostUsd;
    const receiptedProviderCostUsd =
      providerTrainingCostUsd + cumulativeEvaluationCostUsd;
    const cumulativeProviderCostUsd =
      Math.max(
        0,
        receiptedProviderCostUsd -
          nonBillableStartupCorrectionUsd +
          unreceiptedEvaluationCostReserveUsd,
      );
    const evaluationComplete =
      frozen.length > 0 &&
      infrastructureFailureCount === 0 &&
      deploymentCleanupComplete;
    const basePassRate = frozen.length ? basePassed / frozen.length : 0;
    const trainedPassRate = frozen.length ? trainedPassed / frozen.length : 0;
    const absolutePassRateGain = trainedPassRate - basePassRate;
    const thresholdPassed =
      evaluationComplete &&
      trainedPassRate >= FIREWORKS_MINIMUM_TRAINED_PASS_RATE &&
      absolutePassRateGain >= FIREWORKS_MINIMUM_ABSOLUTE_PASS_RATE_GAIN;
    const summary = {
      basePassed,
      trainedPassed,
      totalPerSubject: frozen.length,
      basePassRate,
      trainedPassRate,
      absolutePassRateGain,
      baseInfrastructureFailures,
      trainedInfrastructureFailures,
      infrastructureFailureCount,
      deploymentCleanupComplete,
      estimatedDeploymentCostUsd,
      priorEvaluationCostUsd,
      unreceiptedEvaluationCostReserveUsd,
      nonBillableStartupCorrectionUsd,
      cumulativeEvaluationCostUsd,
      receiptedProviderCostUsd,
      cumulativeProviderCostUsd,
      maximumDeploymentCostUsd,
      maximumRuntimeMs,
      evaluationComplete,
      thresholdPassed,
    };
    const bytes = Buffer.from(`${JSON.stringify({
      schemaVersion: "openpond.fireworksFrozenEvaluation.v1",
      jobId: input.job.id,
      tasksetId: input.taskset.id,
      tasksetHash: input.taskset.contentHash,
      threshold: {
        minimumTrainedPassRate: FIREWORKS_MINIMUM_TRAINED_PASS_RATE,
        minimumAbsolutePassRateGain: FIREWORKS_MINIMUM_ABSOLUTE_PASS_RATE_GAIN,
      },
      runtimeVersion: FIREWORKS_FROZEN_EVALUATION_RUNTIME_VERSION,
      evaluationAttemptId,
      evaluationAttemptNumber,
      reusedStages: reusableStages,
      approvedMaximumCostUsd,
      providerTrainingCostUsd,
      priorEvaluationCostUsd,
      unreceiptedEvaluationCostReserveUsd,
      nonBillableStartupCorrectionUsd,
      maximumDeploymentCostUsd,
      maximumRuntimeMs,
      deployments,
      summary,
      results,
    }, null, 2)}\n`);
    const receiptDirectory = metadataString(input.job, "receiptDirectory");
    const evaluationPath = path.join(
      receiptDirectory,
      `frozen-evaluation-${evaluationAttemptNumber}-${evaluationAttemptId}.json`,
    );
    await writeFile(evaluationPath, bytes);
    const artifact = TrainingArtifactSchema.parse({
      schemaVersion: "openpond.trainingArtifact.v1",
      id: `fireworks_evaluation_${contentHash([input.job.id, sha256(bytes)]).slice(0, 24)}`,
      jobId: input.job.id,
      kind: "evaluation",
      path: evaluationPath,
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      baseModelId: executableBaseRecipe(input.plan)?.baseModel.id ?? null,
      baseModelRevision: executableBaseRecipe(input.plan)?.baseModel.revision ?? null,
      tokenizerRevision: executableBaseRecipe(input.plan)?.baseModel.tokenizerRevision ?? null,
      chatTemplateHash: executableBaseRecipe(input.plan)?.baseModel.chatTemplateHash ?? null,
      nonProduction: false,
      createdAt: this.timestamp(),
      metadata: {
        provider: "fireworks",
        sourceOwnedFrozenEvaluation: true,
        evaluationRuntimeVersion:
          FIREWORKS_FROZEN_EVALUATION_RUNTIME_VERSION,
        evaluationAttemptId,
        evaluationAttemptNumber,
        reusedStages: reusableStages,
        basePassed,
        trainedPassed,
        totalPerSubject: frozen.length,
        basePassRate,
        trainedPassRate,
        absolutePassRateGain,
        baseInfrastructureFailures,
        trainedInfrastructureFailures,
        infrastructureFailureCount,
        deploymentCleanupComplete,
        estimatedDeploymentCostUsd,
        priorEvaluationCostUsd,
        unreceiptedEvaluationCostReserveUsd,
        nonBillableStartupCorrectionUsd,
        cumulativeEvaluationCostUsd,
        receiptedProviderCostUsd,
        cumulativeProviderCostUsd,
        maximumDeploymentCostUsd,
        maximumRuntimeMs,
        evaluationComplete,
        minimumTrainedPassRate: FIREWORKS_MINIMUM_TRAINED_PASS_RATE,
        minimumAbsolutePassRateGain: FIREWORKS_MINIMUM_ABSOLUTE_PASS_RATE_GAIN,
        thresholdPassed,
      },
    });
    await this.deps.store.saveTrainingArtifact(artifact);
    return artifact;
  }
}
