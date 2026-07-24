import type {
  ComputeTargetBinding,
  DatasetRelease,
  EvidenceSetRelease,
  HarnessRelease,
  HarnessRuntimeTargetBinding,
  ModelRunDraft,
  OpaqueSecretLeaseRef,
  Taskset,
  TrainingEngineBinding,
  ResolvedTrainingBundleManifest,
} from "@openpond/contracts";
import { canonicalJson, contentHash, sha256 } from "@openpond/taskset-sdk";

import {
  createHarnessRunManifest,
  publishDatasetRelease,
  publishEvidenceSetRelease,
  publishHarnessRelease,
  validateHarnessRunManifest,
} from "./release-graph.js";

export type PortableTrainingReleaseGraph = {
  harnessRelease: HarnessRelease;
  datasetRelease: DatasetRelease;
  evidenceSetRelease: EvidenceSetRelease | null;
  manifest: ReturnType<typeof createHarnessRunManifest>;
  resolvedBundleManifest: ResolvedTrainingBundleManifest;
  resolvedBundleSource: "materialized" | "external";
  assets: ReadonlyMap<string, Uint8Array>;
};

export function publishTasksetTrainingGraph(input: {
  taskset: Taskset;
  modelRun: ModelRunDraft;
  runtime: HarnessRuntimeTargetBinding;
  compute: ComputeTargetBinding;
  engine: TrainingEngineBinding;
  approval: {
    approvalHash: string;
    approvedAt: string;
    maximumSpendUsd: number | null;
  };
  secretLeaseRefs?: OpaqueSecretLeaseRef[];
  openpondRelease: string;
  workerProtocol: string;
  externalResolvedBundleHash?: string;
}): PortableTrainingReleaseGraph {
  const { taskset, modelRun } = input;
  if (
    !modelRun.baseModel?.revision ||
    !modelRun.baseModel.tokenizerRevision ||
    !modelRun.baseModel.chatTemplateHash ||
    !modelRun.recipe ||
    !modelRun.tasksetRef ||
    modelRun.tasksetRef.id !== taskset.id ||
    modelRun.tasksetRef.contentHash !== taskset.contentHash
  ) {
    throw new Error(
      "Model Run must bind an exact Taskset, Model revision, tokenizer, chat template, and Recipe.",
    );
  }

  const environment = bytes({
    schemaVersion: "openpond.harnessEnvironment.v1",
    environment: taskset.environment,
    capabilities: taskset.capabilities,
    policy: taskset.policy,
  });
  const graders = bytes({
    schemaVersion: "openpond.harnessGraders.v1",
    graders: taskset.graders,
    fixtures: taskset.graderFixtures,
  });
  const toolContract = bytes({
    schemaVersion: "openpond.harnessToolContract.v1",
    toolNames: taskset.environment.toolNames,
    capabilities: taskset.capabilities,
    connectedAppScopes: taskset.policy.connectedAppScopes,
  });
  const feedbackPolicy = bytes({
    schemaVersion: "openpond.harnessFeedbackPolicy.v1",
    policy: taskset.policy,
    graderFixtures: taskset.graderFixtures,
  });
  const dependencyLock = bytes({
    schemaVersion: "openpond.harnessDependencyLock.v1",
    tasksetSdkVersion: taskset.authoringProvenance.tasksetSdkVersion,
    workerProtocol: input.workerProtocol,
  });
  const extensionLock = bytes({
    schemaVersion: "openpond.harnessExtensionLock.v1",
    sourceCommit: taskset.authoringProvenance.sourceCommit,
    skillHash: taskset.authoringProvenance.skillHash,
  });
  const program = bytes({
    schemaVersion: "openpond.harnessProgram.v1",
    entrypoint: taskset.environment.entrypoint,
    lifecycle: taskset.environment.lifecycle,
    deterministicSeeds: taskset.environment.deterministicSeeds,
  });
  const assets = new Map<string, Uint8Array>([
    ["program.json", program],
    ["environment.json", environment],
    ["graders.json", graders],
    ["tool-contract.json", toolContract],
    ["feedback-policy.json", feedbackPolicy],
    ["dependency-lock.json", dependencyLock],
    ["extension-lock.json", extensionLock],
  ]);
  const releaseId = `harness_${taskset.id}_r${taskset.revision}`;
  const child = (
    kind:
      | "program"
      | "tool_contract"
      | "runtime_spec"
      | "grader_definition"
      | "feedback_policy"
      | "dependency_lock"
      | "extension_lock",
    value: unknown,
  ) => ({
    kind,
    id: `${releaseId}_${kind}`,
    contentHash: contentHash(value),
    contractVersion: "1",
  });
  const profileRelease = {
    id: `profile_${taskset.profileId}`,
    revision: taskset.revision,
    contentHash: contentHash({
      profileId: taskset.profileId,
      sourceCommit: taskset.authoringProvenance.sourceCommit,
      skillHash: taskset.authoringProvenance.skillHash,
    }),
  };
  const harnessRelease = publishHarnessRelease({
    schemaVersion: "openpond.harnessRelease.v1",
    id: releaseId,
    revision: taskset.revision,
    profileRelease,
    children: [
      child("program", program),
      child("tool_contract", toolContract),
      child("runtime_spec", taskset.environment),
      child("grader_definition", taskset.graders),
      child("feedback_policy", feedbackPolicy),
      child("dependency_lock", dependencyLock),
      child("extension_lock", extensionLock),
    ],
    assets: [
      asset("program.json", program, [
        "student",
        "orchestrator",
        "environment",
      ], "model_visible"),
      asset("environment.json", environment, [
        "orchestrator",
        "environment",
        "trainer",
      ], "orchestrator_only"),
      asset("graders.json", graders, [
        "privileged_scorer",
      ], "privileged"),
      asset("tool-contract.json", toolContract, [
        "student",
        "orchestrator",
        "environment",
        "trainer",
      ], "model_visible"),
      asset("feedback-policy.json", feedbackPolicy, [
        "orchestrator",
        "privileged_scorer",
        "trainer",
      ], "orchestrator_only"),
      asset("dependency-lock.json", dependencyLock, [
        "trainer",
        "infrastructure",
      ], "orchestrator_only"),
      asset("extension-lock.json", extensionLock, [
        "orchestrator",
        "infrastructure",
      ], "orchestrator_only"),
    ],
    secretDeclarations: taskset.policy.connectedAppScopes.length
      ? [
          {
            id: "connected-app-capability",
            purpose: "Run the Harness with the declared connected-app scopes.",
            audience: "environment",
            required: true,
            ttlSeconds: 900,
            scopes: taskset.policy.connectedAppScopes,
          },
        ]
      : [],
    requiredContracts: {
      openpondRelease: input.openpondRelease,
      workerProtocol: input.workerProtocol,
      harnessRuntime: taskset.environment.protocolVersion,
      trace: "openpond.harnessRunTrace.v1",
    },
    sourceRevision:
      taskset.authoringProvenance.sourceCommit ?? taskset.contentHash,
    publishedAt: modelRun.updatedAt,
    metadata: {
      tasksetId: taskset.id,
      tasksetHash: taskset.contentHash,
      profileId: taskset.profileId,
    },
  });

  const trainTasks = taskset.tasks.filter((task) => task.split === "train");
  const frozenEvalTasks = taskset.tasks.filter(
    (task) => task.split === "frozen_eval",
  );
  const datasetAssets: DatasetRelease["assets"] = [];
  for (const [split, tasks, assetPath] of [
    ["train", trainTasks, "dataset/train.json"],
    ["frozen_eval", frozenEvalTasks, "dataset/frozen-eval.json"],
  ] as const) {
    if (tasks.length === 0) continue;
    const value = bytes({
      schemaVersion: "openpond.datasetSplit.v1",
      split,
      tasks,
    });
    assets.set(assetPath, value);
    datasetAssets.push({
      path: assetPath,
      split,
      sha256: sha256(value),
      sizeBytes: value.byteLength,
      mediaType: "application/json",
    });
  }
  const datasetRelease = publishDatasetRelease({
    schemaVersion: "openpond.datasetRelease.v1",
    id: `dataset_${taskset.id}_r${taskset.revision}`,
    revision: taskset.revision,
    taskset: {
      id: taskset.id,
      contentHash: taskset.contentHash,
    },
    assets: datasetAssets,
    splitCounts: {
      train: trainTasks.length,
      frozenEval: frozenEvalTasks.length,
    },
    sourceRefsHash: contentHash(taskset.sourceRefs),
    publishedAt: modelRun.updatedAt,
    metadata: {
      datasetArtifactHash: contentHash(taskset.datasetArtifact ?? null),
    },
  });
  const approvedEvidenceSignals = Object.values(taskset.learningSignals)
    .flat()
    .filter((signal) => signal.approved);
  const evidenceAssetPaths: string[] = [];
  const evidenceSignals = approvedEvidenceSignals.map((signal) => {
    const value = bytes(signal);
    const signalHash = sha256(value);
    const assetPath = `evidence/signals/${signalHash}.json`;
    assets.set(assetPath, value);
    evidenceAssetPaths.push(assetPath);
    return {
      id: signal.id,
      kind: evidenceKind(signal.kind),
      contentHash: signalHash,
      objectRef: `bundle://${assetPath}`,
      approved: true,
      verificationReceiptHash: contentHash({
        tasksetHash: taskset.contentHash,
        signalId: signal.id,
        approved: signal.approved,
        confidence: signal.confidence,
      }),
    };
  });
  const environmentHash = contentHash(taskset.environment);
  const graderHash = contentHash(taskset.graders);
  const evidenceSetRelease = evidenceSignals.length > 0
    ? publishEvidenceSetRelease({
        schemaVersion: "openpond.evidenceSetRelease.v1",
        id: `evidence_${taskset.id}_r${taskset.revision}`,
        revision: taskset.revision,
        datasetRelease: {
          id: datasetRelease.id,
          contentHash: datasetRelease.contentHash,
        },
        harnessRelease: {
          id: harnessRelease.id,
          contentHash: harnessRelease.contentHash,
        },
        profileRelease: {
          id: profileRelease.id,
          contentHash: profileRelease.contentHash,
        },
        model: {
          source: modelRun.baseModel.modelId,
          revision: modelRun.baseModel.revision,
          artifactHash: null,
        },
        environmentHash,
        toolContractHash: contentHash({
          toolNames: taskset.environment.toolNames,
          capabilities: taskset.capabilities,
        }),
        graderHash,
        signals: evidenceSignals,
        coverageReceiptHash: contentHash({
          taskset: taskset.contentHash,
          readiness: taskset.readiness,
        }),
        verificationPolicyHash: contentHash({
          policy: taskset.policy,
          graderFixtures: taskset.graderFixtures,
        }),
        publishedAt: modelRun.updatedAt,
      })
    : null;
  const evidenceReleasePath = "evidence/evidence-set-release.json";
  if (evidenceSetRelease) {
    assets.set(evidenceReleasePath, bytes(evidenceSetRelease));
  }
  const trainerPaths = new Set([
    ...harnessRelease.assets
      .filter((asset) => asset.projections.includes("trainer"))
      .map((asset) => asset.path),
    ...datasetAssets
      .filter((asset) => asset.split === "train")
      .map((asset) => asset.path),
    ...evidenceAssetPaths,
    ...(evidenceSetRelease ? [evidenceReleasePath] : []),
  ]);
  const resolvedBundleContent = {
    schemaVersion: "openpond.resolvedTrainingBundle.v1" as const,
    projection: "trainer" as const,
    harnessRelease: {
      id: harnessRelease.id,
      contentHash: harnessRelease.contentHash,
    },
    datasetRelease: {
      id: datasetRelease.id,
      contentHash: datasetRelease.contentHash,
    },
    evidenceSetRelease: evidenceSetRelease
      ? {
          id: evidenceSetRelease.id,
          contentHash: evidenceSetRelease.contentHash,
        }
      : null,
    files: [...trainerPaths]
      .sort((left, right) => left.localeCompare(right))
      .map((path) => {
        const value = assets.get(path);
        if (!value) {
          throw new Error(
            `Resolved trainer projection asset ${path} is missing.`,
          );
        }
        return {
          path,
          sha256: sha256(value),
          sizeBytes: value.byteLength,
        };
      }),
  };
  const resolvedBundleManifest = {
    ...resolvedBundleContent,
    contentHash: contentHash(resolvedBundleContent),
  };
  const manifest = createHarnessRunManifest({
    schemaVersion: "openpond.harnessRunManifest.v1",
    id: `manifest_${modelRun.id}_${input.approval.approvalHash.slice(0, 16)}`,
    harnessRelease: {
      id: harnessRelease.id,
      contentHash: harnessRelease.contentHash,
    },
    datasetRelease: {
      id: datasetRelease.id,
      contentHash: datasetRelease.contentHash,
    },
    evidenceSets: evidenceSetRelease
      ? [
          {
            id: evidenceSetRelease.id,
            contentHash: evidenceSetRelease.contentHash,
          },
        ]
      : [],
    model: {
      source: modelRun.baseModel.modelId,
      revision: modelRun.baseModel.revision,
      artifactHash: null,
      tokenizerRevision: modelRun.baseModel.tokenizerRevision,
      chatTemplateHash: modelRun.baseModel.chatTemplateHash,
    },
    recipe: {
      method: modelRun.recipe.method,
      version: "openpond.trainingRecipe.v1",
      configHash: contentHash(modelRun.recipe),
    },
    runtimeTarget: input.runtime,
    computeTarget: input.compute,
    engine: input.engine,
    resolvedBundleHash:
      input.externalResolvedBundleHash ??
      resolvedBundleManifest.contentHash,
    secretLeaseRefs: input.secretLeaseRefs ?? [],
    approval: input.approval,
    createdAt: modelRun.updatedAt,
  });
  const graphIssues = validateHarnessRunManifest(manifest, {
    harnessRelease,
    evidenceSets: evidenceSetRelease ? [evidenceSetRelease] : [],
  });
  if (graphIssues.length > 0) {
    throw new Error(
      `Portable training release graph validation failed: ${graphIssues
        .map((issue) => `${issue.code} (${issue.path})`)
        .join(", ")}`,
    );
  }
  return {
    harnessRelease,
    datasetRelease,
    evidenceSetRelease,
    manifest,
    resolvedBundleManifest,
    resolvedBundleSource:
      input.externalResolvedBundleHash === undefined
        ? "materialized"
        : "external",
    assets,
  };
}

function bytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value), "utf8");
}

function asset(
  path: string,
  value: Uint8Array,
  projections: HarnessRelease["assets"][number]["projections"],
  visibility: HarnessRelease["assets"][number]["visibility"],
): HarnessRelease["assets"][number] {
  return {
    path,
    sha256: sha256(value),
    sizeBytes: value.byteLength,
    mediaType: "application/json",
    executable: false,
    projections,
    visibility,
  };
}

function evidenceKind(
  kind: string,
): EvidenceSetRelease["signals"][number]["kind"] {
  switch (kind) {
    case "feedback":
      return "targeted_feedback";
    case "label":
      return "grader_evidence";
    default:
      return kind as EvidenceSetRelease["signals"][number]["kind"];
  }
}
