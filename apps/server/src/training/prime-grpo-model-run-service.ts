import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  ResolvedTrainingPlanSchema,
  TrainingJobSchema,
  type OpenPondProfileState,
  type ResolvedTrainingPlan,
  type TrainingJob,
} from "@openpond/contracts";
import {
  listPrimeSshKeys,
  PrimeRawComputeHttpClient,
} from "@openpond/compute-provider-prime";
import { canonicalJson, contentHash } from "@openpond/taskset-sdk";
import { scanSshHostFingerprint } from "@openpond/trainer-connected";

import type { SqliteStore } from "../store/store.js";
import {
  buildPrimeGrpoReleaseGraph,
  choosePrimeGrpoQuote,
  createPrimeGrpoTrainingPlan,
  PRIME_RL_SOURCE_IMAGE_DIGEST,
  PRIME_RL_UPSTREAM_REVISION,
  resolvePrimeGrpoPlan,
  type PrimeQuoteCandidate,
} from "./prime-grpo-plan.js";
import {
  publishRunGraph,
  resolveExistingTasksetReleasePublishedAt,
} from "./portable-model-run-service.js";
import {
  resolvePrimeSshIdentity,
} from "./prime-rollout-ssh.js";
import {
  persistSuccessfulRun,
  preparationReceipt,
  prepareModelLifecycle,
  validatePrimeGrpoResolvedPlan,
} from "./prime-grpo-artifact-support.js";
import {
  executePrimeGrpoRun,
  type PrimeGrpoExecutionContext,
  type PrimeGrpoProviderContext,
  type PrimeGrpoProviderNode,
} from "./prime-grpo-execution.js";
import {
  cancelRun,
  failRun,
  isPrimeNodeAlreadyTerminatedError,
  materializeVerifiedPrimeAdapterForImport,
  metadataString,
  providerWalletSpend,
  readVerifiedGroupedReceipt,
  recentPrimeProvisioningFailureDevices,
  requireJob,
  requireMetadataNumber,
  requireMetadataString,
  safeMessage,
  saveJobEvent,
  updateJob,
} from "./prime-grpo-persistence.js";

export {
  createPrimeGrpoBaseModelVersion,
  downloadPrimeGrpoOutputArtifacts,
  materializeRemotePythonProject,
} from "./prime-grpo-artifact-support.js";
export {
  PRIME_GRPO_PYTHON_EXECUTABLE,
  buildPrimeGrpoRemoteCommand,
  createPrimeGrpoFailureReceipt,
  estimatePrimeGrpoCostUsd,
  isPrimeNodeAlreadyTerminatedError,
  materializeVerifiedPrimeAdapterForImport,
  readPrimeGrpoFailureUsage,
  readVerifiedGroupedReceipt,
  recentPrimeProvisioningFailureDevices,
} from "./prime-grpo-persistence.js";

type TrainingService = {
  buildBundle(planId: string): Promise<{
    manifest: import("@openpond/contracts").TrainingBundleManifest;
    directory: string;
    validation: unknown;
  }>;
  approve(input: {
    planId: string;
    bundleId: string;
    approvedBy?: string;
    maximumCostUsd?: number | null;
  }): Promise<import("@openpond/contracts").TrainingApproval>;
};

type ProviderContext = PrimeGrpoProviderContext;
type ProviderNode = PrimeGrpoProviderNode;

type StoredPrimeGrpoExecutionContext = Omit<
  PrimeGrpoExecutionContext,
  "provider" | "quote" | "resumedNode"
>;

export function createPrimeGrpoModelRunService(input: {
  store: SqliteStore;
  storeDir: string;
  training: TrainingService;
  resolvePrimeCredential(): Promise<string>;
  resolveProfile(): Promise<OpenPondProfileState>;
  openpondRelease: string;
  request?: typeof fetch;
  now?: () => Date;
}) {
  const request = input.request ?? fetch;
  const now = input.now ?? (() => new Date());
  const active = new Map<string, Promise<void>>();
  const activeCancellation = new Map<string, () => Promise<void>>();

  async function applies(modelRunId: string): Promise<boolean> {
    const draft = await input.store.getModelRunDraft(modelRunId);
    if (draft?.destinationId === "prime_hosted") return true;
    return (await input.store.listTrainingJobs()).some(
      (job) =>
        job.metadata.modelRunId === modelRunId &&
        job.metadata.primeGrpo === true
    );
  }

  async function prepare(raw: {
    modelRunId: string;
    maximumSpendUsd?: number | null;
    retentionDays?: number | null;
  }) {
    const context = await prepareProviderRun(
      raw.modelRunId,
      raw.maximumSpendUsd ?? null
    );
    return preparationReceipt(context, raw.retentionDays ?? null);
  }

  async function start(raw: {
    modelRunId: string;
    maximumSpendUsd?: number | null;
    retentionDays?: number | null;
    manifest?: unknown;
  }) {
    if (active.has(raw.modelRunId)) {
      throw new Error("This Prime GRPO Model Run is already active.");
    }
    const preflightStartedAt = now().toISOString();
    const prepared = await prepareProviderRun(
      raw.modelRunId,
      raw.maximumSpendUsd ?? null
    );
    const quoteLockedAt = now().toISOString();
    const preparation = preparationReceipt(prepared, raw.retentionDays ?? null);
    const timestamp = quoteLockedAt;
    const { plan, specification } = await createPrimeGrpoTrainingPlan({
      store: input.store,
      draft: prepared.draft,
      taskset: prepared.taskset,
      estimatedCostUsd: prepared.quote.estimatedCostUsd,
      createdAt: timestamp,
    });
    await input.store.saveTrainingPlan(plan);
    const bundleBuildStartedAt = now().toISOString();
    const bundle = await input.training.buildBundle(plan.id);
    const bundleBuildCompletedAt = now().toISOString();
    const approval = await input.training.approve({
      planId: plan.id,
      bundleId: bundle.manifest.id,
      approvedBy: "local_user",
      maximumCostUsd: prepared.maximumSpendUsd,
    });
    const releasedDraft = {
      ...prepared.draft,
      recipe: plan.recipe,
      updatedAt: timestamp,
    };
    await input.store.saveModelRunDraft(releasedDraft);
    const engineCapabilityReceipt = contentHash({
      adapterId: "connected-prime-rl",
      upstreamRevision: PRIME_RL_UPSTREAM_REVISION,
      sourceImageDigest: PRIME_RL_SOURCE_IMAGE_DIGEST,
      runner: "openpond.primeGrpoRunner.v1",
    });
    const releaseGraphStartedAt = now().toISOString();
    const releasePublishedAt = await resolveExistingTasksetReleasePublishedAt({
      storeDir: input.storeDir,
      taskset: prepared.taskset,
    });
    const graph = buildPrimeGrpoReleaseGraph({
      taskset: prepared.taskset,
      draft: releasedDraft,
      approval,
      deviceOrPool: prepared.quote.device.id,
      computeCapabilityReceipt: prepared.inventory.capabilityReceipt,
      engineCapabilityReceipt,
      openpondRelease: input.openpondRelease,
      releasePublishedAt,
    });
    if (
      raw.manifest !== undefined &&
      canonicalJson(raw.manifest) !== canonicalJson(graph.manifest)
    ) {
      throw new Error(
        "Submitted Harness Run Manifest does not match the revalidated Prime GRPO release graph."
      );
    }
    const published = await publishRunGraph({
      storeDir: input.storeDir,
      graph,
    });
    const releaseGraphPublishedAt = now().toISOString();
    const resolvedPlan = resolvePrimeGrpoPlan({
      graph,
      recipe: plan.recipe,
      approval,
    });
    const validation = validatePrimeGrpoResolvedPlan(
      resolvedPlan,
      engineCapabilityReceipt,
      timestamp
    );
    const artifactRoot = path.join(
      input.storeDir,
      "training",
      "prime-grpo",
      graph.manifest.id
    );
    await mkdir(artifactRoot, {
      recursive: true,
      mode: 0o700,
    });
    const resolvedPlanPath = path.join(artifactRoot, "resolved-plan.json");
    const launchPath = path.join(artifactRoot, "launch.json");
    const quoteReceiptPath = path.join(artifactRoot, "prime-quote.json");
    await Promise.all([
      writeFile(resolvedPlanPath, canonicalJson(resolvedPlan), { mode: 0o600 }),
      writeFile(
        launchPath,
        canonicalJson({
          schemaVersion: "openpond.primeGrpoLaunch.v1",
          runId: graph.manifest.id,
          manifestHash: graph.manifest.contentHash,
          taskIds: prepared.taskset.tasks
            .filter((task) => task.split === "train")
            .map((task) => task.id),
        }),
        { mode: 0o600 }
      ),
      writeFile(
        quoteReceiptPath,
        canonicalJson({
          schemaVersion: "openpond.primeWalletQuoteReceipt.v1",
          wallet: prepared.wallet,
          quote: prepared.quote,
          effectiveMaximumSpendUsd: prepared.maximumSpendUsd,
          checkedAt: timestamp,
          contentHash: contentHash({
            wallet: prepared.wallet,
            quote: prepared.quote,
            effectiveMaximumSpendUsd: prepared.maximumSpendUsd,
          }),
        }),
        { mode: 0o600 }
      ),
    ]);
    const job = TrainingJobSchema.parse({
      schemaVersion: "openpond.trainingJob.v1",
      id: graph.manifest.id,
      planId: plan.id,
      bundleHash: bundle.manifest.contentHash,
      approvalId: approval.id,
      destinationId: "prime_hosted",
      status: "queued",
      nonProduction: false,
      workerPid: null,
      startedAt: null,
      completedAt: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: {
        primeGrpo: true,
        modelRunId: releasedDraft.id,
        preflightStartedAt,
        quoteLockedAt,
        bundleBuildStartedAt,
        bundleBuildCompletedAt,
        releaseGraphStartedAt,
        releaseGraphPublishedAt,
        marketingBenchmarkSpecificationId: specification.id,
        marketingBenchmarkSpecificationHash: specification.contentHash,
        walletReceipt: prepared.wallet.receipt,
        walletBalanceUsd: prepared.wallet.balanceUsd,
        quoteId: prepared.quote.quoteId,
        estimatedCostUsd: prepared.quote.estimatedCostUsd,
        hourlyCostUsd: prepared.quote.hourlyCostUsd,
        quoteDeadline: prepared.quote.deadline,
        quoteDurationMs: prepared.quote.durationMs,
        quoteDeviceName: prepared.quote.device.name,
        deadline: prepared.quote.deadline,
        deviceOrPool: prepared.quote.device.id,
        computeCapabilityReceipt: prepared.inventory.capabilityReceipt,
        engineCapabilityReceipt,
        openpondRelease: input.openpondRelease,
        harnessRunManifestId: graph.manifest.id,
        harnessRunManifestHash: graph.manifest.contentHash,
        resolvedBundleDirectory: published.resolvedBundleDirectory,
        manifestPath: published.manifestPath,
        resolvedPlanPath,
        launchPath,
        quoteReceiptPath,
        portableValidationReceipt: validation,
      },
    });
    await input.store.saveTrainingJob(job);
    await saveJobEvent(input.store, job, "queued", {
      phase: "quote_locked",
      quoteId: prepared.quote.quoteId,
      walletReceipt: prepared.wallet.receipt,
      estimatedCostUsd: prepared.quote.estimatedCostUsd,
    });
    await prepareModelLifecycle({
      store: input.store,
      draft: releasedDraft,
      taskset: prepared.taskset,
      graph,
      maximumSpendUsd: prepared.maximumSpendUsd,
      hourlyCostUsd: prepared.quote.hourlyCostUsd,
      startedAt: timestamp,
    });
    await input.store.saveModelRunDraft({
      ...releasedDraft,
      status: "launched",
      updatedAt: timestamp,
    });
    trackExecution({
      job,
      draft: releasedDraft,
      taskset: prepared.taskset,
      graph,
      resolvedPlan,
      resolvedBundleDirectory: published.resolvedBundleDirectory,
      resolvedPlanPath,
      launchPath,
      quote: prepared.quote,
      provider: prepared.provider,
      artifactRoot,
    });
    return {
      preparation,
      manifest: graph.manifest,
      plan,
      bundle: bundle.manifest,
      approval,
      job,
    };
  }

  function trackExecution(context: PrimeGrpoExecutionContext): void {
    if (active.has(context.draft.id)) {
      throw new Error("This Prime GRPO Model Run is already active.");
    }
    const operation = executePrimeGrpoRun(context, {
      store: input.store,
      storeDir: input.storeDir,
      resolveProfile: input.resolveProfile,
      now,
      activeCancellation,
    }).finally(() => {
      active.delete(context.draft.id);
      activeCancellation.delete(context.draft.id);
    });
    active.set(context.draft.id, operation);
    void operation.catch(() => undefined);
  }

  async function status(modelRunId: string) {
    return requireJob(input.store, modelRunId);
  }

  async function events(modelRunId: string) {
    const job = await requireJob(input.store, modelRunId);
    return input.store.listTrainingJobEvents(job.id);
  }

  async function logs(modelRunId: string) {
    const job = await requireJob(input.store, modelRunId);
    return input.store.listTrainingJobEvents(job.id);
  }

  async function artifacts(modelRunId: string) {
    const job = await requireJob(input.store, modelRunId);
    return input.store.listTrainingArtifacts(job.id);
  }

  async function cancel(modelRunId: string) {
    const job = await requireJob(input.store, modelRunId);
    if (
      !["queued", "starting", "running", "reconciling"].includes(job.status)
    ) {
      return job;
    }
    const updated = await updateJob(input.store, job.id, {
      status: "cancelling",
      metadata: { phase: "cancelling" },
    });
    await saveJobEvent(input.store, updated, "cancel", {
      requested: true,
    });
    const liveCancel = activeCancellation.get(modelRunId);
    if (liveCancel) {
      await liveCancel();
      return updated;
    }
    const remoteDirectory = updated.metadata.remoteDirectory;
    const providerNodeId = updated.metadata.providerNodeId;
    if (
      typeof remoteDirectory === "string" &&
      typeof providerNodeId === "string"
    ) {
      const provider = await resolveProvider();
      await provider.client.terminate(providerNodeId).catch(() => undefined);
    }
    return cancelRun({
      store: input.store,
      modelRunId,
      jobId: job.id,
      cancelledAt: now().toISOString(),
    });
  }

  async function reconcile() {
    const candidates = (await input.store.listTrainingJobs()).filter(
      (job) =>
        job.metadata.primeGrpo === true &&
        ["queued", "starting", "running", "reconciling", "cancelling"].includes(
          job.status
        )
    );
    const result = {
      inspected: candidates.length,
      resumed: 0,
      cancelled: 0,
      failed: 0,
      errors: [] as Array<{
        jobId: string;
        error: string;
      }>,
    };
    for (const candidate of candidates) {
      const modelRunId = metadataString(candidate, "modelRunId");
      if (!modelRunId || active.has(modelRunId)) continue;
      if (candidate.status === "cancelling") {
        try {
          await cancel(modelRunId);
          result.cancelled += 1;
        } catch (error) {
          result.errors.push({
            jobId: candidate.id,
            error: safeMessage(error),
          });
        }
        continue;
      }
      const reconciling = await updateJob(input.store, candidate.id, {
        status: "reconciling",
        metadata: {
          phase: "controller_restart_reconciliation",
        },
      });
      await saveJobEvent(input.store, reconciling, "progress", {
        phase: "controller_restart_reconciliation",
      });
      try {
        if (await recoverCompletedLocalExecution(reconciling)) {
          result.resumed += 1;
          continue;
        }
        const context = await restoreExecutionContext(reconciling);
        trackExecution(context);
        result.resumed += 1;
      } catch (error) {
        const message = safeMessage(error);
        const providerNodeId = metadataString(reconciling, "providerNodeId");
        if (providerNodeId) {
          await resolveProvider()
            .then((provider) => provider.client.terminate(providerNodeId))
            .catch(() => undefined);
        }
        await failRun({
          store: input.store,
          modelRunId,
          jobId: reconciling.id,
          error: `Prime GRPO restart reconciliation failed: ${message}`,
          failedAt: now().toISOString(),
        });
        result.failed += 1;
        result.errors.push({
          jobId: reconciling.id,
          error: message,
        });
      }
    }
    return result;
  }

  async function recoverCompletedLocalExecution(
    job: TrainingJob
  ): Promise<boolean> {
    const context = await restoreStoredExecutionContext(job);
    const receiptPath = path.join(
      context.artifactRoot,
      "grouped-grpo-receipt.json"
    );
    let receipt: Record<string, unknown>;
    try {
      receipt = await readVerifiedGroupedReceipt(
        receiptPath,
        context.resolvedPlan
      );
    } catch (error) {
      if ((error as { cause?: { code?: unknown } }).cause?.code === "ENOENT") {
        return false;
      }
      throw error;
    }
    try {
      await materializeVerifiedPrimeAdapterForImport(
        path.join(context.artifactRoot, "output"),
        receipt
      );
    } catch {
      return false;
    }

    const provider = await resolveProvider();
    const providerNodeId = requireMetadataString(job, "providerNodeId");
    try {
      await provider.client.terminate(providerNodeId);
    } catch (error) {
      if (!isPrimeNodeAlreadyTerminatedError(error)) throw error;
    }
    const providerReportedUsd = await provider.client
      .walletBalance()
      .then((wallet) => providerWalletSpend(job, wallet.balanceUsd))
      .catch(() => null);
    const importedAt = now().toISOString();
    const quoteDeadline = requireMetadataString(job, "quoteDeadline");
    const releasedAt = new Date(
      Math.min(Date.parse(quoteDeadline), Date.parse(importedAt))
    ).toISOString();
    const cleanupStartedAt =
      typeof receipt.completedAt === "string"
        ? receipt.completedAt
        : importedAt;
    await updateJob(input.store, job.id, {
      status: "running",
      metadata: {
        phase: "importing_artifacts",
        localReceiptRecovery: true,
        cleanupStartedAt,
        cleanupCompletedAt: importedAt,
      },
    });
    await persistSuccessfulRun({
      store: input.store,
      storeDir: input.storeDir,
      jobId: job.id,
      draft: context.draft,
      taskset: context.taskset,
      graph: context.graph,
      plan: context.resolvedPlan,
      receipt,
      artifactRoot: context.artifactRoot,
      maximumSpendUsd: context.resolvedPlan.maximumSpendUsd ?? 0,
      hourlyCostUsd: requireMetadataNumber(job, "hourlyCostUsd"),
      computeReleased: true,
      tunnelClosed: true,
      completedAt: importedAt,
      providerResource: {
        resourceId: providerNodeId,
        acquiredAt: requireMetadataString(job, "providerAcquiredAt"),
        releasedAt,
        gpuType: requireMetadataString(job, "quoteDeviceName"),
        gpuCount: 1,
        providerReportedUsd,
      },
    });
    return true;
  }

  async function restoreExecutionContext(
    job: TrainingJob
  ): Promise<PrimeGrpoExecutionContext> {
    const stored = await restoreStoredExecutionContext(job);
    const deadline = requireMetadataString(job, "quoteDeadline");
    const remainingDurationMs = new Date(deadline).getTime() - now().getTime();
    if (!Number.isFinite(remainingDurationMs) || remainingDurationMs <= 0) {
      throw new Error(
        "Prime GRPO restart would exceed the persisted quote deadline."
      );
    }
    const quote: PrimeQuoteCandidate = {
      device: {
        id: requireMetadataString(job, "deviceOrPool"),
        name: requireMetadataString(job, "quoteDeviceName"),
      },
      quoteId: requireMetadataString(job, "quoteId"),
      hourlyCostUsd: requireMetadataNumber(job, "hourlyCostUsd"),
      estimatedCostUsd: requireMetadataNumber(job, "estimatedCostUsd"),
      deadline,
      durationMs: remainingDurationMs,
    };
    const provider = await resolveProvider();
    const providerNodeId = metadataString(job, "providerNodeId");
    const resumedNode = providerNodeId
      ? await provider.client.connect(providerNodeId, deadline)
      : null;
    const expectedFingerprint = metadataString(job, "sshHostFingerprint");
    if (
      resumedNode &&
      expectedFingerprint &&
      resumedNode.sshHostFingerprint !== expectedFingerprint
    ) {
      throw new Error(
        "Prime GRPO SSH host fingerprint changed during restart."
      );
    }
    return {
      ...stored,
      quote,
      provider,
      resumedNode,
    };
  }

  async function restoreStoredExecutionContext(
    job: TrainingJob
  ): Promise<StoredPrimeGrpoExecutionContext> {
    const modelRunId = requireMetadataString(job, "modelRunId");
    const draft = await input.store.getModelRunDraft(modelRunId);
    if (!draft || !draft.tasksetRef || !draft.recipe) {
      throw new Error("Prime GRPO restart is missing its saved Model Run.");
    }
    const taskset = await input.store.getTasksetRevision(
      draft.tasksetRef.id,
      draft.tasksetRef.revision,
      draft.tasksetRef.contentHash
    );
    const plan = await input.store.getTrainingPlan(job.planId);
    const approval = await input.store.getTrainingApproval(job.approvalId);
    if (!taskset || !plan || !approval) {
      throw new Error("Prime GRPO restart is missing immutable plan records.");
    }
    const releasePublishedAt = await resolveExistingTasksetReleasePublishedAt({
      storeDir: input.storeDir,
      taskset,
    });
    const graph = buildPrimeGrpoReleaseGraph({
      taskset,
      draft,
      approval,
      deviceOrPool: requireMetadataString(job, "deviceOrPool"),
      computeCapabilityReceipt: requireMetadataString(
        job,
        "computeCapabilityReceipt"
      ),
      engineCapabilityReceipt: requireMetadataString(
        job,
        "engineCapabilityReceipt"
      ),
      openpondRelease: requireMetadataString(job, "openpondRelease"),
      releasePublishedAt,
    });
    if (
      graph.manifest.id !== job.id ||
      graph.manifest.contentHash !== job.metadata.harnessRunManifestHash
    ) {
      throw new Error(
        "Prime GRPO restart release graph does not match the queued Job."
      );
    }
    const resolvedPlan = resolvePrimeGrpoPlan({
      graph,
      recipe: plan.recipe,
      approval,
    });
    const artifactRoot = path.join(
      input.storeDir,
      "training",
      "prime-grpo",
      job.id
    );
    const resolvedPlanPath = path.join(artifactRoot, "resolved-plan.json");
    const launchPath = path.join(artifactRoot, "launch.json");
    const storedPlan = ResolvedTrainingPlanSchema.parse(
      JSON.parse(await readFile(resolvedPlanPath, "utf8"))
    );
    if (canonicalJson(storedPlan) !== canonicalJson(resolvedPlan)) {
      throw new Error("Prime GRPO restart resolved plan changed.");
    }
    const published = await publishRunGraph({
      storeDir: input.storeDir,
      graph,
    });
    return {
      job,
      draft,
      taskset,
      graph,
      resolvedPlan,
      resolvedBundleDirectory: published.resolvedBundleDirectory,
      resolvedPlanPath,
      launchPath,
      artifactRoot,
    };
  }

  async function resolveProvider(): Promise<ProviderContext> {
    const apiKey = await input.resolvePrimeCredential();
    const identity = await resolvePrimeSshIdentity(
      await listPrimeSshKeys({ apiKey, request })
    );
    return {
      privateKeyPath: identity.privateKeyPath,
      client: new PrimeRawComputeHttpClient({
        apiKey: () => input.resolvePrimeCredential(),
        sshKeyId: identity.sshKeyId,
        image: "prime_rl",
        request,
        autoRestart: false,
        readyTimeoutMs: 15 * 60_000,
        verifySshHostKey: scanSshHostFingerprint,
        now,
      }),
    };
  }

  async function prepareProviderRun(
    modelRunId: string,
    requestedMaximumSpendUsd: number | null
  ) {
    const draft = await input.store.getModelRunDraft(modelRunId);
    if (!draft || draft.status !== "ready_to_run") {
      throw new Error("A ready saved Model Run is required.");
    }
    const taskset = draft.tasksetRef
      ? await input.store.getTasksetRevision(
          draft.tasksetRef.id,
          draft.tasksetRef.revision,
          draft.tasksetRef.contentHash
        )
      : null;
    if (!taskset) {
      throw new Error("The saved Model Run Taskset release is unavailable.");
    }
    const provider = await resolveProvider();
    const [wallet, inventory] = await Promise.all([
      provider.client.walletBalance(),
      provider.client.inventory(),
    ]);
    const maximumSpendUsd =
      requestedMaximumSpendUsd === null
        ? wallet.balanceUsd
        : Math.min(requestedMaximumSpendUsd, wallet.balanceUsd);
    const hourDeadline = new Date(now().getTime() + 3_600_000).toISOString();
    const hourly = await Promise.all(
      inventory.devices.map(async (device) => ({
        device,
        quote: await provider.client.quote({
          deviceOrPool: device.id,
          deadline: hourDeadline,
        }),
      }))
    );
    const quote = choosePrimeGrpoQuote({
      devices: inventory.devices.map((device) => ({
        id: device.id,
        name: device.name,
      })),
      hourlyQuotes: new Map(
        hourly.map(({ device, quote }) => [
          device.id,
          {
            quoteId: quote.quoteId,
            hourlyCostUsd: quote.hourlyCostUsd,
          },
        ])
      ),
      walletBalanceUsd: maximumSpendUsd,
      now: now(),
      targetDurationMs: 30 * 60_000,
      excludedDeviceIds: recentPrimeProvisioningFailureDevices(
        await input.store.listTrainingJobs(),
        now()
      ),
    });
    const exact = await provider.client.quote({
      deviceOrPool: quote.device.id,
      deadline: quote.deadline,
    });
    const exactQuote = {
      ...quote,
      quoteId: exact.quoteId,
      hourlyCostUsd: exact.hourlyCostUsd,
      estimatedCostUsd: exact.estimatedCostUsd,
    };
    await createPrimeGrpoTrainingPlan({
      store: input.store,
      draft,
      taskset,
      estimatedCostUsd: exactQuote.estimatedCostUsd,
      createdAt: now().toISOString(),
    });
    return {
      draft,
      taskset,
      provider,
      wallet,
      inventory,
      quote: exactQuote,
      maximumSpendUsd,
    };
  }

  return {
    applies,
    prepare,
    start,
    status,
    events,
    logs,
    artifacts,
    cancel,
    reconcile,
  };
}
