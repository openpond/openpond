import { createServer } from "node:net";
import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  AdapterValidationReceiptSchema,
  ModelArtifactLineageSchema,
  ModelRunSchema,
  ModelVersionSchema,
  ResolvedTrainingPlanSchema,
  TrainingArtifactSchema,
  TrainingJobEventSchema,
  TrainingJobSchema,
  TrainingPreparationPlanSchema,
  type OpenPondProfileState,
  type ModelRunDraft,
  type ResolvedTrainingPlan,
  type Taskset,
  type TrainingJob,
} from "@openpond/contracts";
import {
  listPrimeSshKeys,
  PrimeRawComputeHttpClient,
} from "@openpond/compute-provider-prime";
import { canonicalJson, contentHash, sha256 } from "@openpond/taskset-sdk";
import { scanSshHostFingerprint } from "@openpond/trainer-connected";

import type { SqliteStore } from "../store/store.js";
import { resolvePrimeGrpoBaseProfile } from "./prime-grpo-base-profiles.js";
import { createPrimeGrpoHarness } from "./prime-grpo-harness.js";
import {
  buildPrimeGrpoTelemetryReceipt,
  type PrimeGrpoTelemetrySpan,
} from "./prime-grpo-telemetry.js";
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
  createPrimeRolloutSshTransport,
  resolvePrimeSshIdentity,
} from "./prime-rollout-ssh.js";

const REMOTE_INFERENCE_PORT = 8_000;
const REMOTE_HARNESS_PORT = 17_777;
export const PRIME_GRPO_PYTHON_EXECUTABLE = "python";

export function buildPrimeGrpoRemoteCommand(input: {
  remoteDirectory: string;
  remoteProject: string;
  callbackPort?: number;
  inferencePort?: number;
}): string[] {
  return [
    "env",
    `PYTHONPATH=${input.remoteProject}/src`,
    PRIME_GRPO_PYTHON_EXECUTABLE,
    "-m",
    "openpond_training.prime_grpo_runner",
    "--run-dir",
    input.remoteDirectory,
    "--project-root",
    input.remoteProject,
    "--callback-port",
    String(input.callbackPort ?? REMOTE_HARNESS_PORT),
    "--inference-port",
    String(input.inferencePort ?? REMOTE_INFERENCE_PORT),
    "--model-timeout-seconds",
    "900",
    "--callback-timeout-seconds",
    "600",
  ];
}

export function createPrimeGrpoFailureReceipt(input: {
  modelRunId: string;
  jobId: string;
  stage: string;
  error: string;
  planHash: string;
  manifestHash: string;
  bundleHash: string;
  model: Record<string, unknown>;
  quote: PrimeQuoteCandidate;
  providerResource: Record<string, unknown> | null;
  usage: Record<string, unknown>;
  cost: {
    providerReportedUsd: number | null;
    estimatedUsd: number;
    methodology: string;
    methodologyVersion: string;
  };
  cleanup: {
    remoteStopped: boolean;
    tunnelClosed: boolean;
    computeReleased: boolean;
    startedAt: string;
    completedAt: string;
  };
  startedAt: string;
  completedAt: string;
}) {
  const core = {
    schemaVersion: "openpond.primeGrpoFailureReceipt.v1" as const,
    ...input,
  };
  return {
    ...core,
    contentHash: contentHash(core),
  };
}

export function estimatePrimeGrpoCostUsd(input: {
  acquiredAt: string;
  releasedAt: string;
  hourlyCostUsd: number;
  maximumCostUsd: number;
}): number {
  const acquiredAt = providerTimestampMs(input.acquiredAt);
  const releasedAt = providerTimestampMs(input.releasedAt);
  return roundUsd(
    Math.min(
      input.maximumCostUsd,
      (Math.max(0, releasedAt - acquiredAt) / 3_600_000) * input.hourlyCostUsd
    )
  );
}

export function recentPrimeProvisioningFailureDevices(
  jobs: TrainingJob[],
  currentTime: Date,
  options: {
    recentCooldownMs?: number;
    repeatedFailureCooldownMs?: number;
    repeatedFailureWindowMs?: number;
    repeatedFailureThreshold?: number;
  } = {}
): Set<string> {
  const currentTimeMs = currentTime.getTime();
  const recentCooldownMs = options.recentCooldownMs ?? 30 * 60_000;
  const repeatedFailureCooldownMs =
    options.repeatedFailureCooldownMs ?? 6 * 60 * 60_000;
  const repeatedFailureWindowMs =
    options.repeatedFailureWindowMs ?? 24 * 60 * 60_000;
  const repeatedFailureThreshold = options.repeatedFailureThreshold ?? 2;
  const byDevice = new Map<
    string,
    Array<{ completedAt: number; job: TrainingJob }>
  >();
  for (const job of jobs) {
    const completedAt = job.completedAt
      ? Date.parse(job.completedAt)
      : Number.NaN;
    const deviceId = metadataString(job, "deviceOrPool");
    if (
      job.metadata.primeGrpo !== true ||
      !deviceId ||
      !Number.isFinite(completedAt) ||
      completedAt > currentTimeMs
    ) {
      continue;
    }
    const entries = byDevice.get(deviceId) ?? [];
    entries.push({ completedAt, job });
    byDevice.set(deviceId, entries);
  }

  const excluded = new Set<string>();
  for (const [deviceId, entries] of byDevice) {
    entries.sort((left, right) => right.completedAt - left.completedAt);
    const provisioningFailures: number[] = [];
    for (const entry of entries) {
      if (metadataString(entry.job, "sshReadyAt")) {
        break;
      }
      const failureStage = metadataString(entry.job, "failureStage");
      if (
        entry.job.status === "failed" &&
        (failureStage === "provisioning" ||
          failureStage === "provisioning_ssh") &&
        entry.completedAt >= currentTimeMs - repeatedFailureWindowMs
      ) {
        provisioningFailures.push(entry.completedAt);
      }
    }
    const latestFailure = provisioningFailures[0];
    if (
      latestFailure !== undefined &&
      (latestFailure >= currentTimeMs - recentCooldownMs ||
        (provisioningFailures.length >= repeatedFailureThreshold &&
          latestFailure >= currentTimeMs - repeatedFailureCooldownMs))
    ) {
      excluded.add(deviceId);
    }
  }
  return excluded;
}

export async function readPrimeGrpoFailureUsage(artifactRoot: string): Promise<{
  promptTokens: number;
  generatedTokens: number;
  optimizerSteps: number;
  rolloutGroups: number;
  completedRollouts: number;
}> {
  const state = await readJsonRecord(
    path.join(artifactRoot, "grouped-grpo-state.json")
  );
  const optimizerSteps = Array.isArray(state?.optimizerReceipts)
    ? state.optimizerReceipts.length
    : 0;
  const rolloutGroups = Array.isArray(state?.batchReceipts)
    ? state.batchReceipts.length
    : 0;
  const traceDirectory = path.join(artifactRoot, "traces");
  const filenames = await readdir(traceDirectory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  );
  let promptTokens = 0;
  let generatedTokens = 0;
  let completedRollouts = 0;
  for (const filename of filenames
    .filter((candidate) => candidate.endsWith(".json"))
    .sort()) {
    const trace = await readJsonRecord(path.join(traceDirectory, filename));
    const result = recordValue(trace?.result);
    const sample = recordValue(result?.optimizerSample);
    if (!sample) continue;
    promptTokens += nonnegativeInteger(sample.promptTokenCount);
    generatedTokens += nonnegativeInteger(sample.completionTokenCount);
    completedRollouts += 1;
  }
  return {
    promptTokens,
    generatedTokens,
    optimizerSteps,
    rolloutGroups,
    completedRollouts,
  };
}

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

type ProviderContext = {
  client: PrimeRawComputeHttpClient;
  privateKeyPath: string;
};

type ProviderNode = Awaited<ReturnType<PrimeRawComputeHttpClient["provision"]>>;

type PrimeGrpoExecutionContext = {
  job: TrainingJob;
  draft: NonNullable<Awaited<ReturnType<SqliteStore["getModelRunDraft"]>>>;
  taskset: NonNullable<Awaited<ReturnType<SqliteStore["getTaskset"]>>>;
  graph: ReturnType<typeof buildPrimeGrpoReleaseGraph>;
  resolvedPlan: ResolvedTrainingPlan;
  resolvedBundleDirectory: string;
  resolvedPlanPath: string;
  launchPath: string;
  quote: PrimeQuoteCandidate;
  provider: ProviderContext;
  artifactRoot: string;
  resumedNode?: ProviderNode | null;
};

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
    const operation = execute(context).finally(() => {
      active.delete(context.draft.id);
      activeCancellation.delete(context.draft.id);
    });
    active.set(context.draft.id, operation);
    void operation.catch(() => undefined);
  }

  async function execute(context: PrimeGrpoExecutionContext): Promise<void> {
    let node: ProviderNode | null = context.resumedNode ?? null;
    let transport: Awaited<
      ReturnType<typeof createPrimeRolloutSshTransport>
    > | null = null;
    let tunnel: Awaited<
      ReturnType<
        Awaited<ReturnType<typeof createPrimeRolloutSshTransport>>["openTunnel"]
      >
    > | null = null;
    let harness: Awaited<ReturnType<typeof createPrimeGrpoHarness>> | null =
      null;
    let remoteDirectory: string | null = null;
    let computeReleased = false;
    let tunnelClosed = false;
    try {
      const provisioningStartedAt = now().toISOString();
      await updateJob(input.store, context.job.id, {
        status: "starting",
        startedAt: now().toISOString(),
        metadata: {
          phase: node ? "reconnecting" : "provisioning",
          provisioningStartedAt,
        },
      });
      await saveJobEvent(input.store, context.job, "start", {
        phase: node ? "reconnecting" : "provisioning",
      });
      if (!node) {
        node = await context.provider.client.provision({
          deviceOrPool: context.quote.device.id,
          deadline: context.quote.deadline,
          idempotencyKey: context.job.id,
          onProvisioned: async (resource) => {
            await updateJob(input.store, context.job.id, {
              status: "starting",
              metadata: {
                phase: "provisioning_ssh",
                providerNodeId: resource.nodeId,
                providerAcquiredAt: resource.acquiredAt,
              },
            });
          },
        });
      }
      await updateJob(input.store, context.job.id, {
        status: "running",
        metadata: {
          phase: "bootstrap",
          providerNodeId: node.nodeId,
          providerHost: node.host,
          providerPort: node.port,
          providerUser: node.user,
          sshHostFingerprint: node.sshHostFingerprint,
          providerAcquiredAt: node.acquiredAt,
        },
      });
      const localInferencePort = await availablePort();
      harness = await createPrimeGrpoHarness({
        storeDir: input.storeDir,
        artifactRoot: context.artifactRoot,
        graph: context.graph,
        plan: context.resolvedPlan,
        taskset: context.taskset,
        profile: await input.resolveProfile(),
        localInferencePort,
      });
      transport = await createPrimeRolloutSshTransport({
        host: node.host,
        port: node.port,
        user: node.user,
        expectedFingerprint: node.sshHostFingerprint,
        privateKeyPath: context.provider.privateKeyPath,
        artifactRoot: path.join(context.artifactRoot, "ssh"),
      });
      const sshReadyAt = now().toISOString();
      await updateJob(input.store, context.job.id, {
        status: "running",
        metadata: {
          phase: "uploading_bundle",
          sshReadyAt,
        },
      });
      remoteDirectory = `/tmp/openpond-${context.job.id}`;
      await transport.runRemote(["mkdir", "-p", remoteDirectory]);
      await stopExistingRemoteRunner(transport, remoteDirectory);
      const sourcePythonProject = path.resolve(
        process.cwd(),
        "python",
        "openpond-training"
      );
      const pythonProject = await materializeRemotePythonProject({
        sourceDirectory: sourcePythonProject,
        artifactRoot: context.artifactRoot,
      });
      const bundleUploadStartedAt = now().toISOString();
      await transport.upload(
        [
          context.resolvedBundleDirectory,
          pythonProject,
          context.resolvedPlanPath,
          context.launchPath,
        ],
        remoteDirectory
      );
      const bundleUploadCompletedAt = now().toISOString();
      tunnel = await transport.openTunnel({
        localInferencePort,
        remoteInferencePort: REMOTE_INFERENCE_PORT,
        localHarnessPort: harness.port,
        remoteHarnessPort: REMOTE_HARNESS_PORT,
      });
      activeCancellation.set(context.draft.id, async () => {
        if (!transport || !remoteDirectory) return;
        await transport.runRemote(["touch", `${remoteDirectory}/cancel`]);
      });
      await updateJob(input.store, context.job.id, {
        status: "running",
        metadata: {
          phase: "grouped_grpo",
          providerNodeId: node.nodeId,
          remoteDirectory,
          bundleUploadStartedAt,
          bundleUploadCompletedAt,
          providerHost: node.host,
          providerPort: node.port,
          providerUser: node.user,
          sshHostFingerprint: node.sshHostFingerprint,
          providerAcquiredAt: node.acquiredAt,
        },
      });
      await saveJobEvent(input.store, context.job, "progress", {
        phase: "grouped_grpo",
        providerNodeId: node.nodeId,
      });
      const remoteProject = `${remoteDirectory}/openpond-training`;
      const remoteExecutionStartedAt = now().toISOString();
      await transport.runRemote(
        buildPrimeGrpoRemoteCommand({
          remoteDirectory,
          remoteProject,
        }),
        { timeoutMs: context.quote.durationMs }
      );
      const remoteExecutionCompletedAt = now().toISOString();
      const artifactTransferStartedAt = now().toISOString();
      await Promise.all([
        transport.download(
          `${remoteDirectory}/grouped-grpo-receipt.json`,
          context.artifactRoot
        ),
        transport.download(
          `${remoteDirectory}/grouped-grpo-state.json`,
          context.artifactRoot
        ),
        transport.download(`${remoteDirectory}/vllm.log`, context.artifactRoot),
        transport.download(
          `${remoteDirectory}/prime-rl-worker.log`,
          context.artifactRoot
        ),
        transport.download(
          `${remoteDirectory}/prime-rl-runtime-receipt.json`,
          context.artifactRoot
        ),
        transport.download(
          `${remoteDirectory}/prime-rl-bootstrap.log`,
          context.artifactRoot
        ),
        transport.download(
          `${remoteDirectory}/signals.jsonl`,
          context.artifactRoot
        ),
        downloadPrimeGrpoOutputArtifacts({
          transport,
          remoteDirectory,
          artifactRoot: context.artifactRoot,
        }),
      ]);
      const artifactTransferCompletedAt = now().toISOString();
      const receipt = await readVerifiedGroupedReceipt(
        path.join(context.artifactRoot, "grouped-grpo-receipt.json"),
        context.resolvedPlan
      );
      await materializeVerifiedPrimeAdapterForImport(
        path.join(context.artifactRoot, "output"),
        receipt
      );
      const cleanupStartedAt = now().toISOString();
      await tunnel.close();
      tunnelClosed = true;
      tunnel = null;
      const releasedNode = node;
      await context.provider.client.terminate(node.nodeId);
      computeReleased = true;
      const providerReportedUsd = await context.provider.client
        .walletBalance()
        .then((wallet) => providerWalletSpend(context.job, wallet.balanceUsd))
        .catch(() => null);
      node = null;
      const cleanupCompletedAt = now().toISOString();
      await updateJob(input.store, context.job.id, {
        status: "running",
        metadata: {
          phase: "importing_artifacts",
          remoteExecutionStartedAt,
          remoteExecutionCompletedAt,
          artifactTransferStartedAt,
          artifactTransferCompletedAt,
          cleanupStartedAt,
          cleanupCompletedAt,
        },
      });
      await persistSuccessfulRun({
        store: input.store,
        storeDir: input.storeDir,
        jobId: context.job.id,
        draft: context.draft,
        taskset: context.taskset,
        graph: context.graph,
        plan: context.resolvedPlan,
        receipt,
        artifactRoot: context.artifactRoot,
        maximumSpendUsd: context.resolvedPlan.maximumSpendUsd ?? 0,
        hourlyCostUsd: context.quote.hourlyCostUsd,
        computeReleased,
        tunnelClosed,
        completedAt: now().toISOString(),
        providerResource: {
          resourceId: releasedNode.nodeId,
          acquiredAt: releasedNode.acquiredAt,
          releasedAt: cleanupCompletedAt,
          gpuType: context.quote.device.name,
          gpuCount: 1,
          providerReportedUsd,
        },
      });
    } catch (error) {
      const message = safeMessage(error);
      const failedStage =
        (await input.store.getTrainingJob(context.job.id))?.metadata.phase ??
        "unknown";
      if (transport && remoteDirectory) {
        await Promise.all(
          [
            "vllm-bootstrap.log",
            "vllm-help.txt",
            "vllm.log",
            "prime-rl-worker.log",
            "prime-rl-runtime-receipt.json",
            "prime-rl-bootstrap.log",
            "grouped-grpo-state.json",
            "signals.jsonl",
          ].map((filename) =>
            transport!
              .download(`${remoteDirectory}/${filename}`, context.artifactRoot)
              .catch(() => undefined)
          )
        );
      }
      const cleanupStartedAt = now().toISOString();
      let remoteStopped = transport === null || remoteDirectory === null;
      if (transport && remoteDirectory) {
        remoteStopped = await stopExistingRemoteRunner(
          transport,
          remoteDirectory
        ).then(
          () => true,
          () => false
        );
      }
      await harness?.close().catch(() => undefined);
      harness = null;
      if (tunnel) {
        tunnelClosed = await tunnel.close().then(
          () => true,
          () => false
        );
        tunnel = null;
      } else {
        tunnelClosed = true;
      }
      const acquiredResource = node
        ? {
            resourceId: node.nodeId,
            acquiredAt: node.acquiredAt,
            gpuType: context.quote.device.name,
            gpuCount: 1,
          }
        : null;
      if (node) {
        computeReleased = await context.provider.client
          .terminate(node.nodeId)
          .then(
            () => true,
            () => false
          );
        if (computeReleased) node = null;
      } else {
        computeReleased = true;
      }
      const failedAt = now().toISOString();
      const providerResource = acquiredResource
        ? {
            ...acquiredResource,
            releasedAt: failedAt,
          }
        : null;
      const estimatedCostUsd = providerResource
        ? estimatePrimeGrpoCostUsd({
            acquiredAt: providerResource.acquiredAt,
            releasedAt: failedAt,
            hourlyCostUsd: context.quote.hourlyCostUsd,
            maximumCostUsd: context.quote.estimatedCostUsd,
          })
        : 0;
      const [usage, providerReportedUsd] = await Promise.all([
        readPrimeGrpoFailureUsage(context.artifactRoot),
        context.provider.client
          .walletBalance()
          .then((wallet) => providerWalletSpend(context.job, wallet.balanceUsd))
          .catch(() => null),
      ]);
      const failureReceipt = createPrimeGrpoFailureReceipt({
        modelRunId: context.draft.id,
        jobId: context.job.id,
        stage: String(failedStage),
        error: message,
        planHash: context.resolvedPlan.contentHash,
        manifestHash: context.resolvedPlan.manifest.contentHash,
        bundleHash: context.graph.resolvedBundleManifest.contentHash,
        model: {
          id: context.draft.baseModel!.modelId,
          revision: context.draft.baseModel!.revision,
          tokenizerRevision: context.draft.baseModel!.tokenizerRevision,
          chatTemplateHash: context.draft.baseModel!.chatTemplateHash,
        },
        quote: context.quote,
        providerResource,
        usage,
        cost: {
          providerReportedUsd,
          estimatedUsd: estimatedCostUsd,
          methodology:
            "provider_acquired_elapsed_hours_times_locked_hourly_quote_capped_at_quote",
          methodologyVersion: "1",
        },
        cleanup: {
          remoteStopped,
          tunnelClosed,
          computeReleased,
          startedAt: cleanupStartedAt,
          completedAt: failedAt,
        },
        startedAt: context.job.startedAt ?? context.job.createdAt,
        completedAt: failedAt,
      });
      const failureReceiptPath = path.join(
        context.artifactRoot,
        "prime-grpo-failure-receipt.json"
      );
      await writeFile(failureReceiptPath, canonicalJson(failureReceipt), {
        mode: 0o600,
      });
      await saveFileArtifact({
        store: input.store,
        jobId: context.job.id,
        kind: "metrics",
        filePath: failureReceiptPath,
        createdAt: failedAt,
        metadata: {
          provider: "prime",
          providerFilename: "prime-grpo-failure-receipt.json",
          failureStage: String(failedStage),
        },
      });
      const current = await input.store.getTrainingJob(context.job.id);
      if (current && ["cancelling", "cancelled"].includes(current.status)) {
        await cancelRun({
          store: input.store,
          modelRunId: context.draft.id,
          jobId: context.job.id,
          cancelledAt: failedAt,
        });
        return;
      }
      await failRun({
        store: input.store,
        modelRunId: context.draft.id,
        jobId: context.job.id,
        error: message,
        failedAt,
        metadata: {
          failureStage: String(failedStage),
          failureReceiptPath,
          failureReceiptHash: failureReceipt.contentHash,
          cleanupStartedAt,
          cleanupCompletedAt: failedAt,
          remoteStopped,
          tunnelClosed,
          computeReleased,
          estimatedCostUsd,
          providerReportedUsd,
          costMethodology: failureReceipt.cost.methodology,
          costMethodologyVersion: failureReceipt.cost.methodologyVersion,
        },
      });
      throw error;
    } finally {
      await harness?.close().catch(() => undefined);
      if (tunnel) {
        await tunnel.close().then(
          () => {
            tunnelClosed = true;
          },
          () => undefined
        );
      }
      if (node) {
        await context.provider.client.terminate(node.nodeId).then(
          () => {
            computeReleased = true;
          },
          () => undefined
        );
      }
    }
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

export async function materializeRemotePythonProject(input: {
  sourceDirectory: string;
  artifactRoot: string;
}): Promise<string> {
  const destination = path.join(
    input.artifactRoot,
    "remote",
    "openpond-training"
  );
  await mkdir(destination, {
    recursive: true,
    mode: 0o700,
  });
  await Promise.all([
    copyFile(
      path.join(input.sourceDirectory, "pyproject.toml"),
      path.join(destination, "pyproject.toml")
    ),
    copyFile(
      path.join(input.sourceDirectory, "uv.lock"),
      path.join(destination, "uv.lock")
    ),
    cp(path.join(input.sourceDirectory, "src"), path.join(destination, "src"), {
      recursive: true,
      force: true,
    }),
  ]);
  return destination;
}

export async function downloadPrimeGrpoOutputArtifacts(input: {
  transport: {
    download(remotePath: string, localDirectory: string): Promise<void>;
  };
  remoteDirectory: string;
  artifactRoot: string;
}): Promise<void> {
  const outputDirectory = path.join(input.artifactRoot, "output");
  const adapterDirectory = path.join(outputDirectory, "adapter");
  await Promise.all([
    mkdir(outputDirectory, { recursive: true, mode: 0o700 }),
    mkdir(adapterDirectory, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    input.transport.download(
      `${input.remoteDirectory}/output/adapter/adapter_config.json`,
      adapterDirectory
    ),
    input.transport.download(
      `${input.remoteDirectory}/output/adapter/adapter_model.safetensors`,
      adapterDirectory
    ),
    input.transport.download(
      `${input.remoteDirectory}/output/prime-rl-step-receipts.jsonl`,
      outputDirectory
    ),
  ]);
}

async function readPrimeGrpoTraceReceipts(directory: string): Promise<
  Array<{
    filePath: string;
    value: Record<string, unknown>;
  }>
> {
  const filenames = (await readdir(directory))
    .filter((filename) => filename.endsWith(".json"))
    .sort();
  return Promise.all(
    filenames.map(async (filename) => {
      const filePath = path.join(directory, filename);
      const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Prime GRPO rollout trace must be an object.");
      }
      const receipt = value as Record<string, unknown>;
      const { contentHash: suppliedHash, ...core } = receipt;
      if (suppliedHash !== contentHash(core)) {
        throw new Error("Prime GRPO rollout trace hash is invalid.");
      }
      return { filePath, value: receipt };
    })
  );
}

function primeGrpoLifecycleSpans(
  metadata: Record<string, unknown>
): PrimeGrpoTelemetrySpan[] {
  return [
    lifecycleSpan(
      "preflight_quote",
      metadata.preflightStartedAt,
      metadata.quoteLockedAt
    ),
    lifecycleSpan(
      "bundle_materialization",
      metadata.bundleBuildStartedAt,
      metadata.bundleBuildCompletedAt
    ),
    lifecycleSpan(
      "release_graph_publication",
      metadata.releaseGraphStartedAt,
      metadata.releaseGraphPublishedAt
    ),
    lifecycleSpan(
      "provider_provisioning",
      metadata.provisioningStartedAt,
      metadata.providerAcquiredAt
    ),
    lifecycleSpan(
      "ssh_readiness",
      metadata.providerAcquiredAt,
      metadata.sshReadyAt
    ),
    lifecycleSpan(
      "bundle_upload",
      metadata.bundleUploadStartedAt,
      metadata.bundleUploadCompletedAt
    ),
    lifecycleSpan(
      "remote_execution",
      metadata.remoteExecutionStartedAt,
      metadata.remoteExecutionCompletedAt
    ),
    lifecycleSpan(
      "artifact_transfer",
      metadata.artifactTransferStartedAt,
      metadata.artifactTransferCompletedAt
    ),
    lifecycleSpan(
      "provider_cleanup",
      metadata.cleanupStartedAt,
      metadata.cleanupCompletedAt
    ),
  ].filter((span): span is PrimeGrpoTelemetrySpan => span !== null);
}

function lifecycleSpan(
  name: string,
  startedValue: unknown,
  completedValue: unknown
): PrimeGrpoTelemetrySpan | null {
  if (typeof startedValue !== "string" || typeof completedValue !== "string") {
    return null;
  }
  const startedAt = Date.parse(startedValue);
  const completedAt = Date.parse(completedValue);
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt) ||
    completedAt < startedAt
  ) {
    return null;
  }
  return {
    name,
    startedAt: startedValue,
    completedAt: completedValue,
    durationMs: completedAt - startedAt,
    clock: "wall",
    outcome: "succeeded",
  };
}

async function stopExistingRemoteRunner(
  transport: {
    runRemote(
      command: string[],
      options?: { timeoutMs?: number }
    ): Promise<{ stdout: string; stderr: string }>;
  },
  remoteDirectory: string
): Promise<void> {
  await transport.runRemote(
    [
      "bash",
      "-lc",
      [
        "set -eu",
        'run_dir="$1"',
        'pid_file="$run_dir/openpond-runner.pid"',
        'if [ -f "$pid_file" ]; then',
        '  pid="$(tr -cd \'0-9\' < "$pid_file")"',
        '  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then',
        '    kill -TERM "$pid" 2>/dev/null || true',
        "    attempt=0",
        '    while kill -0 "$pid" 2>/dev/null && [ "$attempt" -lt 50 ]; do',
        "      sleep 0.2",
        "      attempt=$((attempt + 1))",
        "    done",
        '    kill -KILL "$pid" 2>/dev/null || true',
        "  fi",
        '  rm -f "$pid_file"',
        "fi",
        'rm -f "$run_dir/cancel"',
      ].join("\n"),
      "openpond-prime-grpo-reconcile",
      remoteDirectory,
    ],
    { timeoutMs: 20_000 }
  );
}

function preparationReceipt(
  input: {
    draft: { id: string };
    quote: PrimeQuoteCandidate;
    inventory: { capabilityReceipt: string };
    maximumSpendUsd: number;
  },
  retentionDays: number | null
) {
  const bindings = preparationBindings(input);
  const core = {
    schemaVersion: "openpond.trainingPreparationPlan.v1" as const,
    modelRunId: input.draft.id,
    state: "ready" as const,
    reason: null,
    ...bindings,
    downloads: [],
    dataMovement: [
      {
        direction: "upload" as const,
        label: "Resolved training bundle and pinned PRIME-RL runner",
        bytes: null,
      },
      {
        direction: "download" as const,
        label: "LoRA adapter, checkpoints, receipts, and telemetry",
        bytes: null,
      },
    ],
    quoteUsd: input.quote.estimatedCostUsd,
    maximumSpendUsd: input.maximumSpendUsd,
    retentionDays,
    sideEffectsStarted: false as const,
  };
  return TrainingPreparationPlanSchema.parse({
    ...core,
    contentHash: contentHash(core),
  });
}

function preparationBindings(input: {
  quote: PrimeQuoteCandidate;
  inventory: { capabilityReceipt: string };
}) {
  const engineCapabilityReceipt = contentHash({
    adapterId: "connected-prime-rl",
    upstreamRevision: PRIME_RL_UPSTREAM_REVISION,
    sourceImageDigest: PRIME_RL_SOURCE_IMAGE_DIGEST,
    runner: "openpond.primeGrpoRunner.v1",
  });
  return {
    runtime: {
      adapterId: "local-harness",
      placement: "local" as const,
      capabilityReceipt: contentHash("openpond-marketing-portfolio-harness"),
      runtimeVersion: "openpond.primeGrpo.v1",
      dataPlane: null,
    },
    compute: {
      adapterId: "prime-raw",
      kind: "managed" as const,
      deviceOrPool: input.quote.device.id,
      capabilityReceipt: input.inventory.capabilityReceipt,
      provider: "prime",
    },
    engine: {
      adapterId: "connected-prime-rl",
      workerVersion: "openpond.primeGrpo.v1",
      workerImageDigest: PRIME_RL_SOURCE_IMAGE_DIGEST,
      upstreamRevision: PRIME_RL_UPSTREAM_REVISION,
      capabilityReceipt: engineCapabilityReceipt,
    },
  };
}

function validatePrimeGrpoResolvedPlan(
  plan: ResolvedTrainingPlan,
  capabilityReceipt: string,
  createdAt: string
) {
  const issues = [];
  if (
    plan.recipe.method !== "grpo" ||
    !plan.recipe.policyOptimization ||
    plan.engine.adapterId !== "connected-prime-rl" ||
    plan.engine.upstreamRevision !== PRIME_RL_UPSTREAM_REVISION ||
    plan.engine.workerImageDigest !== PRIME_RL_SOURCE_IMAGE_DIGEST ||
    plan.compute.adapterId !== "prime-raw" ||
    plan.runtime.adapterId !== "local-harness" ||
    plan.maximumSpendUsd === null
  ) {
    issues.push({
      code: "prime_grpo_binding_invalid",
      path: null,
      message:
        "Resolved Prime GRPO plan changed its exact model, runtime, compute, engine, or spend binding.",
    });
  }
  const core = {
    schemaVersion: "openpond.adapterValidationReceipt.v1" as const,
    adapterId: "connected-prime-rl",
    valid: issues.length === 0,
    issues,
    capabilityReceipt,
    planHash: plan.contentHash,
    createdAt,
  };
  const receipt = AdapterValidationReceiptSchema.parse({
    ...core,
    contentHash: contentHash(core),
  });
  if (!receipt.valid) {
    throw new Error(receipt.issues[0]!.message);
  }
  return receipt;
}

async function prepareModelLifecycle(input: {
  store: SqliteStore;
  draft: NonNullable<Awaited<ReturnType<SqliteStore["getModelRunDraft"]>>>;
  taskset: NonNullable<Awaited<ReturnType<SqliteStore["getTaskset"]>>>;
  graph: ReturnType<typeof buildPrimeGrpoReleaseGraph>;
  maximumSpendUsd: number;
  hourlyCostUsd: number;
  startedAt: string;
}) {
  const baseVersion = createPrimeGrpoBaseModelVersion({
    draft: input.draft,
    taskset: input.taskset,
    graph: input.graph,
    createdAt: input.startedAt,
  });
  const existingBaseVersion = await input.store.getModelVersion(baseVersion.id);
  if (!existingBaseVersion) {
    await input.store.saveModelVersion(baseVersion);
  } else if (
    existingBaseVersion.kind !== "base_reference" ||
    existingBaseVersion.version !== 0 ||
    existingBaseVersion.modelId !== baseVersion.modelId ||
    existingBaseVersion.profileId !== baseVersion.profileId ||
    existingBaseVersion.taskset.id !== baseVersion.taskset.id ||
    existingBaseVersion.taskset.revision !== baseVersion.taskset.revision ||
    existingBaseVersion.taskset.contentHash !==
      baseVersion.taskset.contentHash ||
    existingBaseVersion.baseModel.modelId !== baseVersion.baseModel.modelId ||
    existingBaseVersion.baseModel.revision !== baseVersion.baseModel.revision
  ) {
    throw new Error(
      "Existing base Model Version does not match the Prime GRPO run."
    );
  }
  const targetVersionId = modelVersionId(input.draft.modelId, 1);
  await input.store.saveModelRun(
    ModelRunSchema.parse({
      schemaVersion: "openpond.modelRun.v1",
      id: input.draft.id,
      modelId: input.draft.modelId,
      modelVersionId: targetVersionId,
      profileId: input.draft.profileId,
      kind: "training",
      status: "prepared",
      method: "grpo",
      destinationId: "prime_hosted",
      taskset: {
        id: input.taskset.id,
        revision: input.taskset.revision,
        contentHash: input.taskset.contentHash,
      },
      quote: {
        maximumSpendUsd: input.maximumSpendUsd,
        hourlyCostUsd: input.hourlyCostUsd,
      },
      reward: null,
      receipt: null,
      adapterArtifactLineageId: null,
      failure: null,
      startedAt: input.startedAt,
      completedAt: null,
      updatedAt: input.startedAt,
    })
  );
}

export function createPrimeGrpoBaseModelVersion(input: {
  draft: ModelRunDraft;
  taskset: Taskset;
  graph: ReturnType<typeof buildPrimeGrpoReleaseGraph>;
  createdAt: string;
}) {
  const baseProfile = resolvePrimeGrpoBaseProfile(input.draft.baseModel);
  const grader = input.taskset.graders[0];
  if (!baseProfile || !grader || !input.taskset.profileRelease) {
    throw new Error(
      "Prime GRPO base Model Version requires the exact base, grader, and Profile release."
    );
  }
  const core = {
    schemaVersion: "openpond.modelVersion.v1" as const,
    id: modelVersionId(input.draft.modelId, 0),
    modelId: input.draft.modelId,
    profileId: input.draft.profileId,
    version: 0,
    kind: "base_reference" as const,
    status: "available" as const,
    baseModel: {
      schemaVersion: "openpond.baseModelPreference.v1" as const,
      modelId: baseProfile.modelId,
      revision: baseProfile.revision,
      tokenizerRevision: baseProfile.tokenizerRevision,
      chatTemplateHash: baseProfile.chatTemplateHash,
      modelAssetId: null,
      source: "managed" as const,
    },
    taskset: {
      id: input.taskset.id,
      revision: input.taskset.revision,
      contentHash: input.taskset.contentHash,
    },
    releaseGraph: {
      resolvedBundleHash: input.graph.resolvedBundleManifest.contentHash,
      profileRelease: input.taskset.profileRelease,
      harnessRelease: input.graph.manifest.harnessRelease,
      agentRelease:
        input.taskset.environment.actionBindings?.[0]?.agentRelease ?? null,
      grader: {
        id: grader.id,
        contentHash: contentHash(grader),
      },
    },
    artifactLineageId: null,
    adapterStatus: "not_trained" as const,
    createdAt: input.createdAt,
  };
  return ModelVersionSchema.parse({
    ...core,
    contentHash: contentHash(core),
  });
}

async function persistSuccessfulRun(input: {
  store: SqliteStore;
  storeDir: string;
  jobId: string;
  draft: NonNullable<Awaited<ReturnType<SqliteStore["getModelRunDraft"]>>>;
  taskset: NonNullable<Awaited<ReturnType<SqliteStore["getTaskset"]>>>;
  graph: ReturnType<typeof buildPrimeGrpoReleaseGraph>;
  plan: ResolvedTrainingPlan;
  receipt: Record<string, unknown>;
  artifactRoot: string;
  maximumSpendUsd: number;
  hourlyCostUsd: number;
  computeReleased: boolean;
  tunnelClosed: boolean;
  completedAt: string;
  providerResource: {
    resourceId: string;
    acquiredAt: string;
    releasedAt: string;
    gpuType: string;
    gpuCount: number;
    providerReportedUsd: number | null;
  };
}) {
  const baseModel = input.draft.baseModel;
  const baseProfile = resolvePrimeGrpoBaseProfile(baseModel);
  if (!baseModel || !baseProfile) {
    throw new Error(
      "Prime GRPO success import requires its exact qualified base profile."
    );
  }
  const output = path.join(input.artifactRoot, "output");
  const weightsPath = path.join(output, "adapter", "adapter_model.safetensors");
  const configPath = path.join(output, "adapter", "adapter_config.json");
  const [weights, config] = await Promise.all([
    readFile(weightsPath),
    readFile(configPath),
  ]);
  const artifactId = `training_artifact_${contentHash([
    input.jobId,
    sha256(weights),
  ]).slice(0, 24)}`;
  const adapterArtifact = await input.store.saveTrainingArtifact(
    TrainingArtifactSchema.parse({
      schemaVersion: "openpond.trainingArtifact.v1",
      id: artifactId,
      jobId: input.jobId,
      kind: "adapter",
      path: weightsPath,
      sha256: sha256(weights),
      sizeBytes: weights.byteLength,
      baseModelId: baseProfile.modelId,
      baseModelRevision: baseProfile.revision,
      tokenizerRevision: baseProfile.tokenizerRevision,
      chatTemplateHash: baseProfile.chatTemplateHash,
      nonProduction: false,
      createdAt: input.completedAt,
      metadata: {
        provider: "prime",
        providerFilename: "adapter_model.safetensors",
        adapterConfigPath: configPath,
        adapterConfigSha256: sha256(config),
        manifestHash: input.plan.manifest.contentHash,
        groupedGrpoReceiptHash: input.receipt.contentHash,
      },
    })
  );
  await saveFileArtifact({
    store: input.store,
    jobId: input.jobId,
    kind: "manifest",
    filePath: configPath,
    createdAt: input.completedAt,
    modelIdentity: {
      baseModelId: baseProfile.modelId,
      baseModelRevision: baseProfile.revision,
      tokenizerRevision: baseProfile.tokenizerRevision,
      chatTemplateHash: baseProfile.chatTemplateHash,
    },
    metadata: {
      provider: "prime",
      providerFilename: "adapter_config.json",
    },
  });
  for (const [kind, filename] of [
    ["metrics", "grouped-grpo-receipt.json"],
    ["metrics", "grouped-grpo-state.json"],
    ["metrics", "signals.jsonl"],
    ["metrics", "prime-rl-runtime-receipt.json"],
    ["log", "prime-rl-bootstrap.log"],
    ["log", "prime-rl-worker.log"],
    ["log", "vllm.log"],
  ] as const) {
    await saveFileArtifact({
      store: input.store,
      jobId: input.jobId,
      kind,
      filePath: path.join(input.artifactRoot, filename),
      createdAt: input.completedAt,
      metadata: { provider: "prime", providerFilename: filename },
    });
  }
  await saveFileArtifact({
    store: input.store,
    jobId: input.jobId,
    kind: "metrics",
    filePath: path.join(output, "prime-rl-step-receipts.jsonl"),
    createdAt: input.completedAt,
    metadata: {
      provider: "prime",
      providerFilename: "prime-rl-step-receipts.jsonl",
    },
  });
  const traceReceipts = await readPrimeGrpoTraceReceipts(
    path.join(input.artifactRoot, "traces")
  );
  for (const trace of traceReceipts) {
    await saveFileArtifact({
      store: input.store,
      jobId: input.jobId,
      kind: "metrics",
      filePath: trace.filePath,
      createdAt: input.completedAt,
      metadata: {
        provider: "prime",
        providerFilename: path.basename(trace.filePath),
        artifactRole: "immutable_rollout_trace",
      },
    });
  }
  const lineageId = `model_lineage_${contentHash([
    input.draft.modelId,
    adapterArtifact.sha256,
    input.plan.contentHash,
  ]).slice(0, 24)}`;
  const planRecord = await input.store.getTrainingPlan(
    (await input.store.getTrainingJob(input.jobId))!.planId
  );
  const job = await input.store.getTrainingJob(input.jobId);
  if (!planRecord || !job) {
    throw new Error(
      "Prime GRPO canonical Training Plan or Job disappeared before import."
    );
  }
  await input.store.saveModelArtifactLineage(
    ModelArtifactLineageSchema.parse({
      schemaVersion: "openpond.modelArtifactLineage.v1",
      id: lineageId,
      modelId: input.draft.modelId,
      artifactId: adapterArtifact.id,
      jobId: input.jobId,
      tasksetId: input.taskset.id,
      tasksetHash: input.taskset.contentHash,
      graderHash: contentHash(input.taskset.graders),
      planHash: planRecord.contentHash,
      bundleHash: job.bundleHash,
      recipeHash: contentHash(planRecord.recipe),
      workerVersion: input.plan.engine.workerVersion,
      trainerVersion: `prime-rl@${PRIME_RL_UPSTREAM_REVISION}`,
      importedAt: input.completedAt,
      frozenEvaluationArtifactId: null,
      promotable: false,
      pinned: false,
      status: "imported",
      rejectedAt: null,
      rejectionReason: null,
      managedServing: null,
    })
  );
  const versionId = modelVersionId(input.draft.modelId, 1);
  const grader = input.taskset.graders[0]!;
  const versionCore = {
    schemaVersion: "openpond.modelVersion.v1" as const,
    id: versionId,
    modelId: input.draft.modelId,
    profileId: input.draft.profileId,
    version: 1,
    kind: "lora_adapter" as const,
    status: "available" as const,
    baseModel: input.draft.baseModel!,
    taskset: {
      id: input.taskset.id,
      revision: input.taskset.revision,
      contentHash: input.taskset.contentHash,
    },
    releaseGraph: {
      resolvedBundleHash: input.graph.resolvedBundleManifest.contentHash,
      profileRelease: input.taskset.profileRelease!,
      harnessRelease: input.graph.manifest.harnessRelease,
      agentRelease:
        input.taskset.environment.actionBindings?.[0]?.agentRelease ?? null,
      grader: {
        id: grader.id,
        contentHash: contentHash(grader),
      },
    },
    artifactLineageId: lineageId,
    adapterStatus: "trained" as const,
    createdAt: input.completedAt,
  };
  await input.store.saveModelVersion(
    ModelVersionSchema.parse({
      ...versionCore,
      contentHash: contentHash(versionCore),
    })
  );
  const optimizerReceipts = Array.isArray(input.receipt.optimizerReceipts)
    ? (input.receipt.optimizerReceipts as Array<Record<string, unknown>>)
    : [];
  const rewardValues = optimizerReceipts
    .map((receipt) => receipt.rewardMean)
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value)
    );
  const reward =
    rewardValues.length > 0
      ? rewardValues.reduce((sum, value) => sum + value, 0) /
        rewardValues.length
      : 0;
  const telemetry = buildPrimeGrpoTelemetryReceipt({
    modelRunId: input.draft.id,
    modelVersionId: versionId,
    groupedReceipt: input.receipt,
    traceReceipts: traceReceipts.map((trace) => trace.value),
    lifecycleSpans: primeGrpoLifecycleSpans(job.metadata),
    provider: {
      ...input.providerResource,
      quotedHourlyUsd: input.hourlyCostUsd,
    },
    base: {
      profileId: baseProfile.baseProfileId,
      repository: baseProfile.modelId,
      revision: baseProfile.revision,
    },
    recordedAt: input.completedAt,
  });
  const runReceiptCore = {
    schemaVersion: "openpond.modelRunReceipt.v1" as const,
    provider: "prime",
    providerRunId: input.jobId,
    assignmentHash: input.plan.manifest.contentHash,
    resultHash: String(input.receipt.contentHash),
    transcriptHash: contentHash(input.receipt.batchReceipts ?? []),
    traceHash: String(input.receipt.contentHash),
    resolvedBundleHash: input.graph.resolvedBundleManifest.contentHash,
    artifactPath: path
      .relative(
        input.storeDir,
        path.join(input.artifactRoot, "grouped-grpo-receipt.json")
      )
      .split(path.sep)
      .join("/"),
    cleanup: {
      computeReleased: input.computeReleased,
      tunnelClosed: input.tunnelClosed,
    },
    telemetry,
  };
  await input.store.saveModelRun(
    ModelRunSchema.parse({
      schemaVersion: "openpond.modelRun.v1",
      id: input.draft.id,
      modelId: input.draft.modelId,
      modelVersionId: versionId,
      profileId: input.draft.profileId,
      kind: "training",
      status: "succeeded",
      method: "grpo",
      destinationId: "prime_hosted",
      taskset: {
        id: input.taskset.id,
        revision: input.taskset.revision,
        contentHash: input.taskset.contentHash,
      },
      quote: {
        maximumSpendUsd: input.maximumSpendUsd,
        hourlyCostUsd: input.hourlyCostUsd,
      },
      reward: { raw: reward, components: {} },
      receipt: {
        ...runReceiptCore,
        contentHash: contentHash(runReceiptCore),
      },
      adapterArtifactLineageId: lineageId,
      failure: null,
      startedAt: job.startedAt ?? job.createdAt,
      completedAt: input.completedAt,
      updatedAt: input.completedAt,
    })
  );
  const succeeded = await updateJob(input.store, input.jobId, {
    status: "succeeded",
    completedAt: input.completedAt,
    error: null,
    metadata: {
      phase: "complete",
      adapterArtifactId: adapterArtifact.id,
      adapterArtifactLineageId: lineageId,
      modelVersionId: versionId,
      groupedGrpoReceiptHash: input.receipt.contentHash,
    },
  });
  await saveJobEvent(input.store, succeeded, "complete", {
    phase: "complete",
    adapterArtifactId: adapterArtifact.id,
    modelVersionId: versionId,
  });
}

async function saveFileArtifact(input: {
  store: SqliteStore;
  jobId: string;
  kind: "metrics" | "log" | "manifest";
  filePath: string;
  createdAt: string;
  metadata: Record<string, unknown>;
  modelIdentity?: {
    baseModelId: string;
    baseModelRevision: string;
    tokenizerRevision: string;
    chatTemplateHash: string;
  };
}) {
  const bytes = await readFile(input.filePath);
  return input.store.saveTrainingArtifact(
    TrainingArtifactSchema.parse({
      schemaVersion: "openpond.trainingArtifact.v1",
      id: `training_artifact_${contentHash([
        input.jobId,
        input.kind,
        sha256(bytes),
      ]).slice(0, 24)}`,
      jobId: input.jobId,
      kind: input.kind,
      path: input.filePath,
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      baseModelId: input.modelIdentity?.baseModelId ?? null,
      baseModelRevision: input.modelIdentity?.baseModelRevision ?? null,
      tokenizerRevision: input.modelIdentity?.tokenizerRevision ?? null,
      chatTemplateHash: input.modelIdentity?.chatTemplateHash ?? null,
      nonProduction: false,
      createdAt: input.createdAt,
      metadata: input.metadata,
    })
  );
}

async function failRun(input: {
  store: SqliteStore;
  modelRunId: string;
  jobId: string;
  error: string;
  failedAt: string;
  metadata?: Record<string, unknown>;
}) {
  const job = await updateJob(input.store, input.jobId, {
    status: "failed",
    completedAt: input.failedAt,
    error: input.error,
    metadata: {
      phase: "failed",
      ...input.metadata,
    },
  });
  await saveJobEvent(input.store, job, "failure", {
    phase: "failed",
    error: input.error,
  });
  const modelRun = await input.store.getModelRun(input.modelRunId);
  if (modelRun && !isTerminalModelRun(modelRun.status)) {
    await input.store.saveModelRun({
      ...modelRun,
      status: "failed",
      failure: input.error,
      completedAt: input.failedAt,
      updatedAt: input.failedAt,
    });
  }
}

async function cancelRun(input: {
  store: SqliteStore;
  modelRunId: string;
  jobId: string;
  cancelledAt: string;
}) {
  const job = await updateJob(input.store, input.jobId, {
    status: "cancelled",
    completedAt: input.cancelledAt,
    error: null,
    metadata: { phase: "cancelled" },
  });
  const events = await input.store.listTrainingJobEvents(job.id);
  if (!events.some((event) => event.type === "cancel")) {
    await saveJobEvent(input.store, job, "cancel", {
      requested: true,
    });
  }
  const modelRun = await input.store.getModelRun(input.modelRunId);
  if (modelRun && !isTerminalModelRun(modelRun.status)) {
    await input.store.saveModelRun({
      ...modelRun,
      status: "cancelled",
      failure: "Cancelled by user.",
      completedAt: input.cancelledAt,
      updatedAt: input.cancelledAt,
    });
  }
  return job;
}

function verifyGroupedReceipt(
  value: unknown,
  plan: ResolvedTrainingPlan
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Prime grouped-GRPO receipt must be an object.");
  }
  const receipt = value as Record<string, unknown>;
  const { contentHash: suppliedHash, ...core } = receipt;
  if (
    suppliedHash !== contentHash(core) ||
    receipt.schemaVersion !== "openpond.groupedGrpoCoordinatorReceipt.v1" ||
    receipt.runId !== plan.manifest.id ||
    receipt.manifestId !== plan.manifest.id ||
    receipt.manifestHash !== plan.manifest.contentHash ||
    receipt.optimizerSteps !==
      (plan.recipe.method === "grpo" ? plan.recipe.optimizer.maxSteps : -1) ||
    receipt.finalPolicyVersion !==
      (plan.recipe.method === "grpo" ? plan.recipe.optimizer.maxSteps : -1)
  ) {
    throw new Error("Prime grouped-GRPO receipt hash or lineage is invalid.");
  }
  return receipt;
}

export async function readVerifiedGroupedReceipt(
  receiptPath: string,
  plan: ResolvedTrainingPlan
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch (error) {
    throw new Error("Prime grouped-GRPO canonical receipt could not be read.", {
      cause: error,
    });
  }
  return verifyGroupedReceipt(value, plan);
}

function expectedAdapterIdentity(receipt: Record<string, unknown>): {
  configSha256: string;
  weightsSha256: string;
} {
  const optimizerReceipts = receipt.optimizerReceipts;
  if (!Array.isArray(optimizerReceipts) || optimizerReceipts.length === 0) {
    throw new Error("Prime grouped-GRPO receipt has no optimizer update.");
  }
  const final = optimizerReceipts.at(-1);
  if (!final || typeof final !== "object" || Array.isArray(final)) {
    throw new Error("Prime grouped-GRPO final optimizer receipt is invalid.");
  }
  const adapter = (final as Record<string, unknown>).adapter;
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) {
    throw new Error("Prime grouped-GRPO final adapter receipt is invalid.");
  }
  const identity = adapter as Record<string, unknown>;
  if (
    typeof identity.configSha256 !== "string" ||
    typeof identity.weightsSha256 !== "string"
  ) {
    throw new Error("Prime grouped-GRPO adapter hashes are invalid.");
  }
  return {
    configSha256: identity.configSha256,
    weightsSha256: identity.weightsSha256,
  };
}

async function verifyAdapterDirectory(
  adapterDirectory: string,
  receipt: Record<string, unknown>
): Promise<void> {
  const identity = expectedAdapterIdentity(receipt);
  const config = path.join(adapterDirectory, "adapter_config.json");
  const weights = path.join(adapterDirectory, "adapter_model.safetensors");
  await Promise.all([readFile(config), readFile(weights)]).then(
    ([configBytes, weightBytes]) => {
      if (
        sha256(configBytes) !== identity.configSha256 ||
        sha256(weightBytes) !== identity.weightsSha256
      ) {
        throw new Error(
          "Downloaded Prime LoRA adapter changed after optimizer receipt."
        );
      }
    }
  );
}

export async function materializeVerifiedPrimeAdapterForImport(
  outputDirectory: string,
  receipt: Record<string, unknown>
): Promise<{ recoveredFrom: string | null }> {
  const canonicalDirectory = path.join(outputDirectory, "adapter");
  try {
    await verifyAdapterDirectory(canonicalDirectory, receipt);
    return { recoveredFrom: null };
  } catch (canonicalError) {
    const finalPolicyVersion = receipt.finalPolicyVersion;
    if (
      typeof finalPolicyVersion !== "number" ||
      !Number.isInteger(finalPolicyVersion) ||
      finalPolicyVersion < 1
    ) {
      throw canonicalError;
    }
    const recoveryDirectory = path.join(
      outputDirectory,
      ".prime-rl",
      "output",
      "weights",
      `step_${finalPolicyVersion}`,
      "lora_adapters"
    );
    try {
      await verifyAdapterDirectory(recoveryDirectory, receipt);
      await mkdir(canonicalDirectory, { recursive: true, mode: 0o700 });
      await Promise.all([
        copyFile(
          path.join(recoveryDirectory, "adapter_config.json"),
          path.join(canonicalDirectory, "adapter_config.json")
        ),
        copyFile(
          path.join(recoveryDirectory, "adapter_model.safetensors"),
          path.join(canonicalDirectory, "adapter_model.safetensors")
        ),
      ]);
      await verifyAdapterDirectory(canonicalDirectory, receipt);
      return { recoveredFrom: recoveryDirectory };
    } catch (recoveryError) {
      throw new Error(
        "Prime LoRA adapter is unavailable in both the canonical and recoverable optimizer outputs.",
        { cause: recoveryError }
      );
    }
  }
}

async function requireJob(store: SqliteStore, modelRunId: string) {
  const job = (await store.listTrainingJobs()).find(
    (candidate) =>
      candidate.id === modelRunId ||
      candidate.metadata.modelRunId === modelRunId
  );
  if (!job || job.metadata.primeGrpo !== true) {
    throw new Error("No Prime GRPO execution exists for this Model Run.");
  }
  return job;
}

async function updateJob(
  store: SqliteStore,
  jobId: string,
  update: {
    status?: TrainingJob["status"];
    startedAt?: string | null;
    completedAt?: string | null;
    error?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  const job = await store.getTrainingJob(jobId);
  if (!job) {
    throw new Error(`Training Job ${jobId} is unavailable.`);
  }
  return store.saveTrainingJob(
    TrainingJobSchema.parse({
      ...job,
      ...update,
      metadata: {
        ...job.metadata,
        ...update.metadata,
      },
      updatedAt: new Date().toISOString(),
    })
  );
}

async function saveJobEvent(
  store: SqliteStore,
  job: TrainingJob,
  type: import("@openpond/contracts").TrainingJobEvent["type"],
  payload: Record<string, unknown>
) {
  const sequence = (await store.listTrainingJobEvents(job.id)).length;
  return store.saveTrainingJobEvent(
    TrainingJobEventSchema.parse({
      schemaVersion: "openpond.trainingJobEvent.v1",
      id: `training_event_${contentHash([
        job.id,
        sequence,
        type,
        payload,
      ]).slice(0, 24)}`,
      jobId: job.id,
      sequence,
      type,
      timestamp: new Date().toISOString(),
      payload,
    })
  );
}

function modelVersionId(modelId: string, version: number): string {
  return `model_version_${contentHash({
    modelId,
    version,
  }).slice(0, 24)}`;
}

function isTerminalModelRun(status: string): boolean {
  return ["succeeded", "failed", "cancelled"].includes(status);
}

function metadataString(job: TrainingJob, key: string): string | null {
  const value = job.metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function requireMetadataString(job: TrainingJob, key: string): string {
  const value = metadataString(job, key);
  if (!value) {
    throw new Error(`Prime GRPO Job is missing metadata ${key}.`);
  }
  return value;
}

function requireMetadataNumber(job: TrainingJob, key: string): number {
  const value = job.metadata[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Prime GRPO Job has invalid metadata ${key}.`);
  }
  return value;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : null;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  if (!port) throw new Error("Failed to allocate an inference port.");
  return port;
}

function safeMessage(error: unknown): string {
  return (
    (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 5_000) || "Prime GRPO execution failed."
  );
}

export function isPrimeNodeAlreadyTerminatedError(error: unknown): boolean {
  return /Prime API DELETE .* failed \((?:404|410)\):/.test(
    error instanceof Error ? error.message : String(error)
  );
}

function providerTimestampMs(value: string): number {
  const timezoneQualified = /(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i.test(value)
    ? value
    : `${value}Z`;
  const timestamp = Date.parse(timezoneQualified);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Prime provider timestamp is invalid.");
  }
  return timestamp;
}

function providerWalletSpend(
  job: TrainingJob,
  finalBalanceUsd: number
): number | null {
  const initialBalanceUsd = job.metadata.walletBalanceUsd;
  if (
    typeof initialBalanceUsd !== "number" ||
    !Number.isFinite(initialBalanceUsd) ||
    !Number.isFinite(finalBalanceUsd)
  ) {
    return null;
  }
  return roundUsd(Math.max(0, initialBalanceUsd - finalBalanceUsd));
}

async function readJsonRecord(
  filePath: string
): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return recordValue(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
