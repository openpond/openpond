import {
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  type OpenPondProfileState,
  type ResolvedTrainingPlan,
  type TrainingJob,
} from "@openpond/contracts";
import { PrimeRawComputeHttpClient } from "@openpond/compute-provider-prime";
import { canonicalJson } from "@openpond/taskset-sdk";

import type { SqliteStore } from "../store/store.js";
import { createPrimeGrpoHarness } from "./prime-grpo-harness.js";
import {
  buildPrimeGrpoReleaseGraph,
  type PrimeQuoteCandidate,
} from "./prime-grpo-plan.js";
import { createPrimeRolloutSshTransport } from "./prime-rollout-ssh.js";
import {
  downloadPrimeGrpoOutputArtifacts,
  materializeRemotePythonProject,
  persistSuccessfulRun,
  stopExistingRemoteRunner,
} from "./prime-grpo-artifact-support.js";
import {
  availablePort,
  buildPrimeGrpoRemoteCommand,
  cancelRun,
  createPrimeGrpoFailureReceipt,
  estimatePrimeGrpoCostUsd,
  failRun,
  materializeVerifiedPrimeAdapterForImport,
  providerWalletSpend,
  readPrimeGrpoFailureUsage,
  readVerifiedGroupedReceipt,
  safeMessage,
  saveFileArtifact,
  saveJobEvent,
  updateJob,
} from "./prime-grpo-persistence.js";

const REMOTE_INFERENCE_PORT = 8_000;
const REMOTE_HARNESS_PORT = 17_777;

export type PrimeGrpoProviderContext = {
  client: PrimeRawComputeHttpClient;
  privateKeyPath: string;
};

export type PrimeGrpoProviderNode = Awaited<
  ReturnType<PrimeRawComputeHttpClient["provision"]>
>;

export type PrimeGrpoExecutionContext = {
  job: TrainingJob;
  draft: NonNullable<Awaited<ReturnType<SqliteStore["getModelRunDraft"]>>>;
  taskset: NonNullable<Awaited<ReturnType<SqliteStore["getTaskset"]>>>;
  graph: ReturnType<typeof buildPrimeGrpoReleaseGraph>;
  resolvedPlan: ResolvedTrainingPlan;
  resolvedBundleDirectory: string;
  resolvedPlanPath: string;
  launchPath: string;
  quote: PrimeQuoteCandidate;
  provider: PrimeGrpoProviderContext;
  artifactRoot: string;
  resumedNode?: PrimeGrpoProviderNode | null;
};

export async function executePrimeGrpoRun(
  context: PrimeGrpoExecutionContext,
  deps: {
    store: SqliteStore;
    storeDir: string;
    resolveProfile(): Promise<OpenPondProfileState>;
    now(): Date;
    activeCancellation: Map<string, () => Promise<void>>;
  },
): Promise<void> {
  let node: PrimeGrpoProviderNode | null = context.resumedNode ?? null;
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
    const provisioningStartedAt = deps.now().toISOString();
    await updateJob(deps.store, context.job.id, {
      status: "starting",
      startedAt: deps.now().toISOString(),
      metadata: {
        phase: node ? "reconnecting" : "provisioning",
        provisioningStartedAt,
      },
    });
    await saveJobEvent(deps.store, context.job, "start", {
      phase: node ? "reconnecting" : "provisioning",
    });
    if (!node) {
      node = await context.provider.client.provision({
        deviceOrPool: context.quote.device.id,
        deadline: context.quote.deadline,
        idempotencyKey: context.job.id,
        onProvisioned: async (resource) => {
          await updateJob(deps.store, context.job.id, {
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
    await updateJob(deps.store, context.job.id, {
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
      storeDir: deps.storeDir,
      artifactRoot: context.artifactRoot,
      graph: context.graph,
      plan: context.resolvedPlan,
      taskset: context.taskset,
      profile: await deps.resolveProfile(),
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
    const sshReadyAt = deps.now().toISOString();
    await updateJob(deps.store, context.job.id, {
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
    const bundleUploadStartedAt = deps.now().toISOString();
    await transport.upload(
      [
        context.resolvedBundleDirectory,
        pythonProject,
        context.resolvedPlanPath,
        context.launchPath,
      ],
      remoteDirectory
    );
    const bundleUploadCompletedAt = deps.now().toISOString();
    tunnel = await transport.openTunnel({
      localInferencePort,
      remoteInferencePort: REMOTE_INFERENCE_PORT,
      localHarnessPort: harness.port,
      remoteHarnessPort: REMOTE_HARNESS_PORT,
    });
    deps.activeCancellation.set(context.draft.id, async () => {
      if (!transport || !remoteDirectory) return;
      await transport.runRemote(["touch", `${remoteDirectory}/cancel`]);
    });
    await updateJob(deps.store, context.job.id, {
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
    await saveJobEvent(deps.store, context.job, "progress", {
      phase: "grouped_grpo",
      providerNodeId: node.nodeId,
    });
    const remoteProject = `${remoteDirectory}/openpond-training`;
    const remoteExecutionStartedAt = deps.now().toISOString();
    await transport.runRemote(
      buildPrimeGrpoRemoteCommand({
        remoteDirectory,
        remoteProject,
      }),
      { timeoutMs: context.quote.durationMs }
    );
    const remoteExecutionCompletedAt = deps.now().toISOString();
    const artifactTransferStartedAt = deps.now().toISOString();
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
    const artifactTransferCompletedAt = deps.now().toISOString();
    const receipt = await readVerifiedGroupedReceipt(
      path.join(context.artifactRoot, "grouped-grpo-receipt.json"),
      context.resolvedPlan
    );
    await materializeVerifiedPrimeAdapterForImport(
      path.join(context.artifactRoot, "output"),
      receipt
    );
    const cleanupStartedAt = deps.now().toISOString();
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
    const cleanupCompletedAt = deps.now().toISOString();
    await updateJob(deps.store, context.job.id, {
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
      store: deps.store,
      storeDir: deps.storeDir,
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
      completedAt: deps.now().toISOString(),
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
      (await deps.store.getTrainingJob(context.job.id))?.metadata.phase ??
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
    const cleanupStartedAt = deps.now().toISOString();
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
    const failedAt = deps.now().toISOString();
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
      store: deps.store,
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
    const current = await deps.store.getTrainingJob(context.job.id);
    if (current && ["cancelling", "cancelled"].includes(current.status)) {
      await cancelRun({
        store: deps.store,
        modelRunId: context.draft.id,
        jobId: context.job.id,
        cancelledAt: failedAt,
      });
      return;
    }
    await failRun({
      store: deps.store,
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

