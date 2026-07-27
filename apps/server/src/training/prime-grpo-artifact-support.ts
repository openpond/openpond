import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";

import {
  AdapterValidationReceiptSchema,
  ModelArtifactLineageSchema,
  ModelRunSchema,
  ModelVersionSchema,
  TrainingArtifactSchema,
  TrainingPreparationPlanSchema,
  type ModelRunDraft,
  type ResolvedTrainingPlan,
  type Taskset,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";

import type { SqliteStore } from "../store/store.js";
import { resolvePrimeGrpoBaseProfile } from "./prime-grpo-base-profiles.js";
import {
  buildPrimeGrpoTelemetryReceipt,
  type PrimeGrpoTelemetrySpan,
} from "./prime-grpo-telemetry.js";
import {
  buildPrimeGrpoReleaseGraph,
  PRIME_RL_SOURCE_IMAGE_DIGEST,
  PRIME_RL_UPSTREAM_REVISION,
  type PrimeQuoteCandidate,
} from "./prime-grpo-plan.js";
import {
  modelVersionId,
  saveFileArtifact,
  saveJobEvent,
  updateJob,
} from "./prime-grpo-persistence.js";

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

export async function readPrimeGrpoTraceReceipts(directory: string): Promise<
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

export function primeGrpoLifecycleSpans(
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

export function lifecycleSpan(
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

export async function stopExistingRemoteRunner(
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

export function preparationReceipt(
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

export function preparationBindings(input: {
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

export function validatePrimeGrpoResolvedPlan(
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

export async function prepareModelLifecycle(input: {
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

export async function persistSuccessfulRun(input: {
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

