import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ModelArtifactLineageSchema,
  TrainingArtifactSchema,
  TrainingJobSchema,
  type TrainingApproval,
  type TrainingArtifact,
  type TrainingCompatibilityReport,
  type TrainingJob,
  type TrainingPlan,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import {
  fireworksMoneyUsd,
  resourceId,
  type FireworksRftJob,
  type FireworksSftJob,
} from "./fireworks-client.js";
import { renderFireworksRftDataset } from "./fireworks-dataset.js";
import {
  provisionFireworksRftEvaluator,
  validateFireworksRftPublicBaseUrl,
} from "./fireworks-rft-evaluator.js";
import { FireworksDestinationEvaluation } from "./fireworks-destination-evaluation.js";
import {
  artifactKind,
  boundedProviderPayload,
  errorMessage,
  isConflict,
  metadataNumber,
  metadataString,
  normalizedJob,
  providerId,
  providerOptimizerUpdates,
  providerOutputModel,
  providerProgress,
  providerTerminalReceiptComplete,
  safeArtifactName,
  waitForDataset,
} from "./fireworks-provider-utils.js";

const FIREWORKS_MAX_APPROVED_COST_USD = 9.99;
const TERMINAL_PROVIDER_STATES = new Set([
  "JOB_STATE_COMPLETED",
  "JOB_STATE_EARLY_STOPPED",
  "JOB_STATE_FAILED",
  "JOB_STATE_CANCELLED",
  "JOB_STATE_EXPIRED",
  "JOB_STATE_DELETED",
]);

export type FireworksProviderCredential = {
  value: string;
  source: "local_secret" | "env";
  createdAt: string;
  updatedAt: string;
};

export type FireworksTrainingValidation = {
  checkedAt: string;
  accountId: string | null;
  modelId: string | null;
  modelMetadataHash: string | null;
  rftSupported: boolean;
  ok: boolean;
  error: string | null;
};

export abstract class FireworksDestinationJob extends FireworksDestinationEvaluation {
  private readonly collectionPromises = new Map<string, Promise<TrainingJob>>();

  abstract validate(plan: TrainingPlan): Promise<TrainingCompatibilityReport>;
  abstract quote(plan: TrainingPlan): Promise<{
    estimatedCostUsd: number;
    assumptions: string[];
  }>;

  protected async launchRft(
    plan: TrainingPlan,
    approval: TrainingApproval,
  ): Promise<TrainingJob> {
    if (plan.recipe.method !== "grpo") {
      throw new Error("Fireworks RFT launch requires a GRPO recipe.");
    }
    this.assertApproval(plan, approval);
    const compatibility = await this.validate(plan);
    if (!compatibility.compatible) {
      throw new Error(
        `Fireworks RFT plan is incompatible: ${compatibility.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    const quote = await this.quote(plan);
    if (
      approval.maximumCostUsd == null ||
      approval.maximumCostUsd <= 0 ||
      approval.maximumCostUsd > FIREWORKS_MAX_APPROVED_COST_USD
    ) {
      throw new Error(
        `Fireworks RFT launch requires an explicit maximum cost from $0.01 to $${FIREWORKS_MAX_APPROVED_COST_USD.toFixed(2)}.`,
      );
    }
    if (quote.estimatedCostUsd > approval.maximumCostUsd) {
      throw new Error(
        `Fireworks RFT estimate $${quote.estimatedCostUsd.toFixed(2)} exceeds the approved $${approval.maximumCostUsd.toFixed(2)} maximum.`,
      );
    }
    const publicBaseUrl =
      this.deps.rftPublicBaseUrl?.() ??
      process.env.OPENPOND_FIREWORKS_RFT_PUBLIC_URL ??
      null;
    if (!publicBaseUrl) {
      throw new Error(
        "Fireworks RFT requires OPENPOND_FIREWORKS_RFT_PUBLIC_URL ending in /v1/training/fireworks/rft.",
      );
    }
    const validatedPublicBaseUrl = validateFireworksRftPublicBaseUrl(publicBaseUrl);
    await this.assertNoConcurrentRftJob(approval.id);
    const validation = await this.validateProvider(true);
    if (!validation.ok || !validation.accountId) {
      throw new Error(validation.error ?? "Fireworks RFT capability validation failed.");
    }
    const taskset = await this.requireTaskset(plan.tasksetId);
    const bundle = await this.deps.store.findTrainingBundleByPlanAndHash(
      plan.id,
      approval.bundleHash,
    );
    if (!bundle) throw new Error("Approved Training Bundle was not found.");
    const credential = await this.requireCredential();
    const client = this.client(credential.value);
    const rendered = renderFireworksRftDataset(taskset);
    const accountId = validation.accountId;
    const datasetId = providerId("op-rft-data", bundle.contentHash);
    const remoteJobId = providerId("op-rft", approval.id);
    const outputModelId = providerId("op-rft-model", approval.id);
    const receiptDirectory = path.join(
      this.deps.storeDir,
      "training",
      "fireworks",
      remoteJobId,
    );
    await mkdir(receiptDirectory, { recursive: true });
    const datasetPath = path.join(receiptDirectory, "train.fireworks-rft.jsonl");
    await writeFile(datasetPath, rendered.bytes);
    let providerDataset;
    try {
      providerDataset = await client.createDataset({
        accountId,
        datasetId,
        displayName: `OpenPond RFT ${taskset.name}`.slice(0, 63),
        exampleCount: rendered.exampleCount,
      });
      await client.uploadDataset({
        accountId,
        datasetId,
        filename: "train-rft.jsonl",
        bytes: rendered.bytes,
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
      providerDataset = await client.dataset(accountId, datasetId);
    }
    providerDataset = await waitForDataset(client, accountId, datasetId);
    const provision = this.deps.provisionRftEvaluator ?? provisionFireworksRftEvaluator;
    const evaluator = await provision({
      accountId,
      apiKey: credential.value,
      baseModelId: plan.recipe.baseModel.id,
      publicBaseUrl: validatedPublicBaseUrl,
      directory: path.join(this.deps.storeDir, "training", "fireworks", "evaluators"),
    });
    const timestamp = this.timestamp();
    let job = TrainingJobSchema.parse({
      schemaVersion: "openpond.trainingJob.v1",
      id: `training_job_fireworks_${contentHash([accountId, remoteJobId]).slice(0, 24)}`,
      planId: plan.id,
      bundleHash: bundle.contentHash,
      approvalId: approval.id,
      destinationId: this.id,
      status: "starting",
      nonProduction: false,
      workerPid: null,
      startedAt: timestamp,
      completedAt: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: {
        provider: "fireworks",
        trainingMethod: "grpo",
        providerAccountId: accountId,
        providerDatasetId: datasetId,
        providerDatasetName: providerDataset.name,
        providerDatasetHash: rendered.contentHash,
        providerDatasetExampleCount: rendered.exampleCount,
        providerDatasetTaskIds: rendered.taskIds,
        providerEstimatedTokens: rendered.estimatedTokens,
        providerEvaluatorId: evaluator.evaluatorId,
        providerEvaluatorName: evaluator.evaluatorName,
        providerEvaluatorSourceHash: evaluator.sourceHash,
        providerRemoteEnvironmentUrl: evaluator.publicBaseUrl,
        providerJobId: remoteJobId,
        providerRunId: remoteJobId,
        providerPolicyModel: plan.recipe.baseModel.id,
        outputModelId,
        outputModelName: `accounts/${accountId}/models/${outputModelId}`,
        baseModel: plan.recipe.baseModel.id,
        canonicalBundleHash: bundle.contentHash,
        tasksetId: taskset.id,
        tasksetHash: taskset.contentHash,
        credentialSource: credential.source,
        credentialUpdatedAt: credential.updatedAt,
        trainingCapabilityValidatedAt: validation.checkedAt,
        baseModelProviderMetadataHash: validation.modelMetadataHash,
        approvedMaximumCostUsd: approval.maximumCostUsd,
        quotedCostUsd: quote.estimatedCostUsd,
        providerRetentionDays: plan.dataPolicy.retentionDays,
        providerDatasetDeletionStatus: "retained",
        providerArtifactDeletionStatus: "retained",
        receiptDirectory,
        optimizerUpdatesObserved: 0,
      },
    });
    await this.deps.store.saveTrainingJob(job);
    await this.appendEvent(job, "start", {
      stage: "provider_job_create",
      providerJobId: remoteJobId,
      providerDatasetHash: rendered.contentHash,
      providerEvaluatorSourceHash: evaluator.sourceHash,
      canonicalBundleHash: bundle.contentHash,
      approvedMaximumCostUsd: approval.maximumCostUsd,
    });
    let providerJob: FireworksRftJob;
    try {
      providerJob = await client.createRftJob({
        accountId,
        jobId: remoteJobId,
        displayName: `OpenPond RFT ${taskset.name}`.slice(0, 63),
        datasetName: providerDataset.name,
        evaluatorName: evaluator.evaluatorName,
        outputModelId,
        baseModel: plan.recipe.baseModel.id,
        learningRate: plan.recipe.optimizer.learningRate,
        maxContextLength: plan.recipe.dataset.maxPromptTokens,
        loraRank: plan.recipe.lora.rank,
        maxSteps: plan.recipe.optimizer.maxSteps,
        groupSize: plan.recipe.rollout.groupSize,
        maxOutputTokens: plan.recipe.rollout.maxOutputTokens,
        temperature: plan.recipe.rollout.temperature,
        topP: plan.recipe.rollout.topP,
        maxConcurrentRollouts: plan.recipe.rollout.concurrency,
      });
    } catch (error) {
      if (isConflict(error)) {
        providerJob = await client.rftJob(accountId, remoteJobId);
      } else {
        job = TrainingJobSchema.parse({
          ...job,
          status: "failed",
          completedAt: this.timestamp(),
          updatedAt: this.timestamp(),
          error: errorMessage(error),
        });
        await this.deps.store.saveTrainingJob(job);
        await this.appendEvent(job, "failure", {
          stage: "provider_job_create",
          error: errorMessage(error),
        });
        throw error;
      }
    }
    const providerEstimate = fireworksMoneyUsd(providerJob.estimatedCost);
    if (providerEstimate != null && providerEstimate > approval.maximumCostUsd) {
      await client.cancelRftJob(accountId, remoteJobId).catch(() => undefined);
      throw new Error(
        `Fireworks RFT live estimate $${providerEstimate.toFixed(2)} exceeds the approved $${approval.maximumCostUsd.toFixed(2)} maximum; the job was cancelled.`,
      );
    }
    job = normalizedJob(job, providerJob, this.timestamp());
    job = TrainingJobSchema.parse({
      ...job,
      metadata: {
        ...job.metadata,
        providerJobName: providerJob.name,
        providerJobState: providerJob.state ?? null,
        providerExperimentId: providerJob.name,
        providerEstimatedCostUsd: providerEstimate,
        outputModelName: providerOutputModel(
          accountId,
          providerJob.trainingConfig?.outputModel,
          outputModelId,
        ),
        providerRftConfigHash: contentHash({
          trainingConfig: providerJob.trainingConfig,
          inferenceParameters: providerJob.inferenceParameters,
          lossConfig: providerJob.lossConfig,
          maxConcurrentRollouts: providerJob.maxConcurrentRollouts,
        }),
      },
    });
    await this.deps.store.saveTrainingJob(job);
    await this.appendEvent(job, "progress", {
      stage: "provider_job_created",
      ...providerProgress(providerJob),
    });
    return job;
  }

  protected async statusRft(job: TrainingJob): Promise<TrainingJob> {
    if (
      providerTerminalReceiptComplete(job)
    ) {
      return job;
    }
    const credential = await this.requireCredential();
    const client = this.client(credential.value);
    const providerJob = await client.rftJob(
      metadataString(job, "providerAccountId"),
      metadataString(job, "providerJobId"),
    );
    let updated = normalizedJob(job, providerJob, this.timestamp());
    const optimizerUpdates = providerOptimizerUpdates(providerJob);
    updated = TrainingJobSchema.parse({
      ...updated,
      metadata: {
        ...updated.metadata,
        optimizerUpdatesObserved: optimizerUpdates,
        providerOutputStats: boundedProviderPayload(providerJob.outputStats),
        providerOutputMetrics: boundedProviderPayload(providerJob.outputMetrics),
      },
    });
    if (updated.status === "succeeded" && optimizerUpdates <= 0) {
      updated = TrainingJobSchema.parse({
        ...updated,
        status: "failed",
        error:
          "Fireworks reported RFT completion without a provider receipt proving optimizer updates.",
      });
    }
    const approvedMaximum = metadataNumber(job, "approvedMaximumCostUsd");
    const providerEstimate = fireworksMoneyUsd(providerJob.estimatedCost);
    if (
      providerEstimate != null &&
      approvedMaximum != null &&
      providerEstimate > approvedMaximum &&
      !TERMINAL_PROVIDER_STATES.has(providerJob.state ?? "")
    ) {
      await client.cancelRftJob(
        metadataString(job, "providerAccountId"),
        metadataString(job, "providerJobId"),
      ).catch(() => undefined);
      updated = TrainingJobSchema.parse({
        ...updated,
        status: "cancelling",
        error: `Fireworks RFT estimate $${providerEstimate.toFixed(2)} exceeded the approved $${approvedMaximum.toFixed(2)} maximum.`,
        metadata: {
          ...updated.metadata,
          budgetCancellationRequested: true,
          providerEstimatedCostUsd: providerEstimate,
        },
      });
    }
    await this.deps.store.saveTrainingJob(updated);
    await this.recordRftMetrics(updated, providerJob, client);
    updated = await this.deps.store.getTrainingJob(updated.id) ?? updated;
    if (updated.status !== job.status || providerJob.state !== job.metadata.providerJobState) {
      await this.appendEvent(
        updated,
        updated.status === "succeeded"
          ? "complete"
          : updated.status === "failed"
            ? "failure"
            : updated.status === "cancelled"
              ? "cancel"
              : "progress",
        {
          ...providerProgress(providerJob),
          optimizerUpdatesObserved: optimizerUpdates,
        },
      );
    }
    if (updated.status === "succeeded" && updated.metadata.providerCollected !== true) {
      updated = await this.collectProviderOnce(
        updated.id,
        () => this.collectCompletedRft(updated, providerJob, credential.value),
      );
    }
    return updated;
  }

  protected collectProviderOnce(
    jobId: string,
    collect: () => Promise<TrainingJob>,
  ): Promise<TrainingJob> {
    const existing = this.collectionPromises.get(jobId);
    if (existing) return existing;
    let promise!: Promise<TrainingJob>;
    promise = collect().finally(() => {
      if (this.collectionPromises.get(jobId) === promise) {
        this.collectionPromises.delete(jobId);
      }
    });
    this.collectionPromises.set(jobId, promise);
    return promise;
  }

  protected async collectCompletedRft(
    job: TrainingJob,
    providerJob: FireworksRftJob,
    apiKey: string,
  ): Promise<TrainingJob> {
    const existing = await this.deps.store.listTrainingArtifacts(job.id);
    if (job.metadata.providerCollected === true && existing.length) return job;
    const plan = await this.deps.store.getTrainingPlan(job.planId);
    if (!plan || plan.recipe.method !== "grpo") {
      throw new Error("Fireworks job lost its GRPO plan.");
    }
    const optimizerUpdates = providerOptimizerUpdates(providerJob);
    if (optimizerUpdates <= 0) {
      throw new Error(
        "Fireworks reported RFT completion without a provider receipt proving optimizer updates.",
      );
    }
    const taskset = await this.requireTaskset(plan.tasksetId);
    const accountId = metadataString(job, "providerAccountId");
    const outputModelName = metadataString(job, "outputModelName");
    const outputModelId = resourceId(outputModelName);
    const client = this.client(apiKey);
    const outputDirectory = path.join(
      this.deps.storeDir,
      "training",
      "fireworks",
      metadataString(job, "providerJobId"),
      "model",
    );
    await mkdir(outputDirectory, { recursive: true });
    const downloadUrls = await client.modelDownloadUrls(accountId, outputModelId);
    const artifacts: TrainingArtifact[] = [];
    for (const [filename, url] of Object.entries(downloadUrls).sort(([left], [right]) =>
      left.localeCompare(right))) {
      const safeName = safeArtifactName(filename);
      const bytes = await client.download(url);
      const artifactPath = path.join(outputDirectory, safeName);
      await writeFile(artifactPath, bytes);
      const artifact = TrainingArtifactSchema.parse({
        schemaVersion: "openpond.trainingArtifact.v1",
        id: `fireworks_artifact_${contentHash([job.id, filename, sha256(bytes)]).slice(0, 24)}`,
        jobId: job.id,
        kind: artifactKind(safeName),
        path: artifactPath,
        sha256: sha256(bytes),
        sizeBytes: bytes.byteLength,
        baseModelId: plan.recipe.baseModel.id,
        baseModelRevision: plan.recipe.baseModel.revision,
        tokenizerRevision: plan.recipe.baseModel.tokenizerRevision,
        chatTemplateHash: plan.recipe.baseModel.chatTemplateHash,
        nonProduction: false,
        createdAt: this.timestamp(),
        metadata: {
          provider: "fireworks",
          trainingMethod: "grpo",
          providerFilename: filename,
          providerJobId: metadataString(job, "providerJobId"),
          outputModelName,
          optimizerUpdatesObserved: optimizerUpdates,
        },
      });
      await this.deps.store.saveTrainingArtifact(artifact);
      artifacts.push(artifact);
    }
    if (!artifacts.length) throw new Error("Fireworks RFT returned no downloadable Model files.");
    await this.recordRftMetrics(job, providerJob, client);
    const evaluationArtifact = await this.evaluateFrozen({
      job,
      plan,
      taskset,
      client,
      baseModel: plan.recipe.baseModel.id,
      trainedModel: outputModelName,
    });
    if (evaluationArtifact) artifacts.push(evaluationArtifact);
    const adapterArtifact =
      artifacts.find(
        (artifact) =>
          artifact.kind === "adapter"
          && artifact.metadata.providerFilename === "adapter_model.safetensors",
      ) ??
      artifacts.find((artifact) => artifact.kind === "adapter") ??
      artifacts.find((artifact) => artifact.kind === "checkpoint") ??
      artifacts[0]!;
    const thresholdPassed = evaluationArtifact?.metadata.thresholdPassed === true;
    const evaluationComplete = evaluationArtifact?.metadata.evaluationComplete === true;
    const lineage = ModelArtifactLineageSchema.parse({
      schemaVersion: "openpond.modelArtifactLineage.v1",
      id: `lineage_${adapterArtifact.id}`,
      modelId: plan.modelId,
      artifactId: adapterArtifact.id,
      jobId: job.id,
      tasksetId: taskset.id,
      tasksetHash: taskset.contentHash,
      graderHash: contentHash(taskset.graders),
      planHash: plan.contentHash,
      bundleHash: job.bundleHash,
      recipeHash: contentHash(plan.recipe),
      workerVersion: "fireworks-managed-api-v1",
      trainerVersion: "fireworks-reinforcementFineTuningJobs-v1",
      importedAt: this.timestamp(),
      frozenEvaluationArtifactId: evaluationArtifact?.id ?? null,
      promotable: thresholdPassed && optimizerUpdates > 0,
      status: "imported",
    });
    await this.deps.store.saveModelArtifactLineage(lineage);
    const updated = TrainingJobSchema.parse({
      ...job,
      status: "succeeded",
      completedAt: providerJob.completedTime ?? job.completedAt ?? this.timestamp(),
      updatedAt: this.timestamp(),
      error: null,
      metadata: {
        ...job.metadata,
        providerCollected: true,
        providerArtifactCount: artifacts.length,
        importedModelLineageId: lineage.id,
        frozenEvaluationArtifactId: evaluationArtifact?.id ?? null,
        frozenEvaluationComplete: evaluationComplete,
        frozenEvaluationThresholdPassed: thresholdPassed,
        optimizerUpdatesObserved: optimizerUpdates,
      },
    });
    await this.deps.store.saveTrainingJob(updated);
    await this.appendEvent(updated, "checkpoint", {
      providerArtifactCount: artifacts.length,
      importedModelLineageId: lineage.id,
      frozenEvaluationArtifactId: evaluationArtifact?.id ?? null,
      optimizerUpdatesObserved: optimizerUpdates,
    });
    return updated;
  }

  protected async collectCompleted(
    job: TrainingJob,
    providerJob: FireworksSftJob,
    apiKey: string,
  ): Promise<TrainingJob> {
    const existing = await this.deps.store.listTrainingArtifacts(job.id);
    if (job.metadata.providerCollected === true && existing.length) return job;
    const plan = await this.deps.store.getTrainingPlan(job.planId);
    if (!plan || plan.recipe.method !== "sft") throw new Error("Fireworks job lost its SFT plan.");
    const taskset = await this.requireTaskset(plan.tasksetId);
    const accountId = metadataString(job, "providerAccountId");
    const outputModelName = metadataString(job, "outputModelName");
    const outputModelId = resourceId(outputModelName);
    const client = this.client(apiKey);
    const outputDirectory = path.join(
      this.deps.storeDir,
      "training",
      "fireworks",
      metadataString(job, "providerJobId"),
      "model",
    );
    await mkdir(outputDirectory, { recursive: true });
    const downloadUrls = await client.modelDownloadUrls(accountId, outputModelId);
    const artifacts: TrainingArtifact[] = [];
    for (const [filename, url] of Object.entries(downloadUrls).sort(([left], [right]) =>
      left.localeCompare(right))) {
      const safeName = safeArtifactName(filename);
      const bytes = await client.download(url);
      const artifactPath = path.join(outputDirectory, safeName);
      await writeFile(artifactPath, bytes);
      const artifact = TrainingArtifactSchema.parse({
        schemaVersion: "openpond.trainingArtifact.v1",
        id: `fireworks_artifact_${contentHash([job.id, filename, sha256(bytes)]).slice(0, 24)}`,
        jobId: job.id,
        kind: artifactKind(safeName),
        path: artifactPath,
        sha256: sha256(bytes),
        sizeBytes: bytes.byteLength,
        baseModelId: plan.recipe.baseModel.id,
        baseModelRevision: plan.recipe.baseModel.revision,
        tokenizerRevision: plan.recipe.baseModel.tokenizerRevision,
        chatTemplateHash: plan.recipe.baseModel.chatTemplateHash,
        nonProduction: false,
        createdAt: this.timestamp(),
        metadata: {
          provider: "fireworks",
          providerFilename: filename,
          providerJobId: metadataString(job, "providerJobId"),
          outputModelName,
        },
      });
      await this.deps.store.saveTrainingArtifact(artifact);
      artifacts.push(artifact);
    }
    if (!artifacts.length) throw new Error("Fireworks returned no downloadable Model files.");

    const evaluationArtifact = await this.evaluateFrozen({
      job,
      plan,
      taskset,
      client,
      baseModel: plan.recipe.baseModel.id,
      trainedModel: outputModelName,
    });
    if (evaluationArtifact) artifacts.push(evaluationArtifact);
    const adapterArtifact =
      artifacts.find(
        (artifact) =>
          artifact.kind === "adapter"
          && artifact.metadata.providerFilename === "adapter_model.safetensors",
      ) ??
      artifacts.find((artifact) => artifact.kind === "adapter") ??
      artifacts.find((artifact) => artifact.kind === "checkpoint") ??
      artifacts[0]!;
    const thresholdPassed = evaluationArtifact?.metadata.thresholdPassed === true;
    const evaluationComplete = evaluationArtifact?.metadata.evaluationComplete === true;
    const lineage = ModelArtifactLineageSchema.parse({
      schemaVersion: "openpond.modelArtifactLineage.v1",
      id: `lineage_${adapterArtifact.id}`,
      modelId: plan.modelId,
      artifactId: adapterArtifact.id,
      jobId: job.id,
      tasksetId: taskset.id,
      tasksetHash: taskset.contentHash,
      graderHash: contentHash(taskset.graders),
      planHash: plan.contentHash,
      bundleHash: job.bundleHash,
      recipeHash: contentHash(plan.recipe),
      workerVersion: "fireworks-managed-api-v1",
      trainerVersion: "fireworks-supervisedFineTuningJobs-v2",
      importedAt: this.timestamp(),
      frozenEvaluationArtifactId: evaluationArtifact?.id ?? null,
      promotable: thresholdPassed,
      status: "imported",
    });
    await this.deps.store.saveModelArtifactLineage(lineage);
    const updated = TrainingJobSchema.parse({
      ...job,
      status: "succeeded",
      completedAt: providerJob.completedTime ?? job.completedAt ?? this.timestamp(),
      updatedAt: this.timestamp(),
      error: null,
      metadata: {
        ...job.metadata,
        providerCollected: true,
        providerArtifactCount: artifacts.length,
        importedModelLineageId: lineage.id,
        frozenEvaluationArtifactId: evaluationArtifact?.id ?? null,
        frozenEvaluationComplete: evaluationComplete,
        frozenEvaluationThresholdPassed: thresholdPassed,
      },
    });
    await this.deps.store.saveTrainingJob(updated);
    await this.appendEvent(updated, "checkpoint", {
      providerArtifactCount: artifacts.length,
      importedModelLineageId: lineage.id,
      frozenEvaluationArtifactId: evaluationArtifact?.id ?? null,
    });
    return updated;
  }
}
