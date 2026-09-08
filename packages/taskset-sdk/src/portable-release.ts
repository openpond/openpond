import type {
  GraderSpec,
  TaskDataRecord,
  Taskset,
} from "@openpond/contracts";
import {
  TaskRecordSchema,
  GraderSpecSchema as PortableGraderSpecSchema,
  TasksetReleaseContentSchema,
  TasksetReleaseSchema,
  bindTasksetExecutionReleases,
  createEnvironmentRelease,
  createVerifierSetRelease,
  EnvironmentReleaseSchema,
  VerifierSetReleaseSchema,
  verifyEnvironmentRelease,
  verifyVerifierSetRelease,
  verifyPreferenceComparisonRelease,
  type EnvironmentContract,
  type GraderSpec as PortableGraderSpec,
  type PreferenceComparisonRelease,
  type TasksetRelease,
} from "@openpond/evals";
import type {
  ImmutableAssetRef,
  ToolDeclaration,
} from "@openpond/harness";
import {
  CapabilityRequirementSchema,
  ImmutableAssetRefSchema,
  ToolDeclarationSchema,
} from "@openpond/harness";

import { canonicalJson } from "./canonical-json.js";
import { contentHash, sha256 } from "./hashing.js";
import { TaskBatchPackageMetadataSchema } from "@openpond/evals/learning";
import { compileBoundGraders, RewardBindingSchema, RewardReleaseSchema, type RewardBinding, type RewardRelease } from "@openpond/evals/rewards";

export type TasksetRewardExecution = { binding: RewardBinding; rewards: RewardRelease[] };

export function resolvePortableTasksetRewardExecution(taskset: Taskset, supplied?: TasksetRewardExecution): TasksetRewardExecution | null {
  const learning = taskset.metadata.learning === undefined ? null : TaskBatchPackageMetadataSchema.parse(taskset.metadata.learning);
  const embedded = taskset.metadata.rewardExecution as { binding?: unknown; rewards?: unknown } | undefined;
  const execution = supplied ?? (embedded ? {
    binding: RewardBindingSchema.parse(embedded.binding),
    rewards: RewardReleaseSchema.array().parse(embedded.rewards),
  } : learning);
  if (taskset.metadata.rewardBinding !== undefined) {
    const reference = taskset.metadata.rewardBinding as Partial<RewardBinding> | null;
    if (!execution || !reference || reference.id !== execution.binding.id
      || reference.revision !== execution.binding.revision || reference.contentHash !== execution.binding.contentHash) {
      throw new Error("Portable Taskset requires its exact published Reward binding.");
    }
  }
  if (execution) compileBoundGraders(execution.binding, execution.rewards);
  return execution ? { binding: execution.binding, rewards: execution.rewards } : null;
}

export function materializePortableTasksetRelease(input: {
  taskset: Taskset;
  selectedTasks?: TaskDataRecord[];
  adapterId: string;
  admittedTasksetRelease?: TasksetRelease | null;
  rewardExecution?: TasksetRewardExecution;
}): {
  environmentRelease: ReturnType<typeof createEnvironmentRelease>;
  verifierSetRelease: ReturnType<typeof createVerifierSetRelease>;
  tasksetRelease: TasksetRelease;
} {
  const environment = portableEnvironment(input.taskset);
  const tools = portableTools(input.taskset);
  const learning = input.taskset.metadata.learning === undefined ? null : TaskBatchPackageMetadataSchema.parse(input.taskset.metadata.learning);
  const embedded = input.taskset.metadata.rewardExecution;
  const rewardExecution = resolvePortableTasksetRewardExecution(input.taskset, input.rewardExecution);
  const graders = rewardExecution ? compileBoundGraders(rewardExecution.binding, rewardExecution.rewards) : input.taskset.graders.map(portableGrader);
  const tasks = input.selectedTasks?.length
    ? input.selectedTasks
    : input.taskset.tasks;
  if (!tasks.length) throw new Error("A portable Taskset release requires at least one task.");
  const pinned = input.taskset.environment.metadata.portableExecutionResources as { environment?: unknown; verifierSet?: unknown } | undefined;
  if (environment.entrypoint === "openpond.javascript-environment.v1" && !pinned) throw new Error("Tool Taskset publication requires its pinned execution resources.");
  const environmentRelease = pinned ? EnvironmentReleaseSchema.parse(pinned.environment) : createEnvironmentRelease({
    schemaVersion: "openpond.environmentRelease.v1",
    id: `environment-release-${input.taskset.id}-r${input.taskset.revision}`,
    revision: input.taskset.revision,
    contract: environment,
    actionSchemaRef: null,
    observationSchemaRef: null,
    stateSchemaRef: null,
    artifactCollection: {
      maxArtifacts: 100_000,
      maxTotalBytes: 250_000_000,
    },
    adapterConformanceHashes: {
      [input.adapterId]: contentHash({ adapterId: input.adapterId, environment, tools }),
    },
    metadata: {
      sourceTasksetId: input.taskset.id,
      sourcePackageHash: input.taskset.metadata.sourcePackageHash ?? null,
      resources: input.taskset.environment.resources ?? [],
    },
  });
  const verifierSetRelease = pinned?.verifierSet !== undefined ? VerifierSetReleaseSchema.parse(pinned.verifierSet) : createVerifierSetRelease({
    schemaVersion: "openpond.verifierSetRelease.v1",
    id: `verifier-set-release-${input.taskset.id}-r${input.taskset.revision}`,
    revision: input.taskset.revision,
    graders,
    isolation: {
      processBoundary: "isolated_process",
      networkPolicy: "none",
      defaultTimeoutMs: Math.min(input.taskset.environment.defaultTimeoutMs, 300_000),
    },
    calibrationReceiptRefs: [],
    metadata: { sourceTasksetId: input.taskset.id },
  });
  if (!verifyEnvironmentRelease(environmentRelease) || !verifyVerifierSetRelease(verifierSetRelease) ||
      contentHash(environmentRelease.contract) !== contentHash(environment) || contentHash(verifierSetRelease.graders) !== contentHash(graders)) {
    throw new Error("Taskset execution resources differ from its declared environment or graders.");
  }
  const tasksetContent = TasksetReleaseContentSchema.parse({
    schemaVersion: "openpond.tasksetRelease.v2",
    id: input.taskset.metadata.derivedPortableMetadata === undefined ? `taskset-release-${input.taskset.id}-r${input.taskset.revision}` : input.taskset.id,
    revision: input.taskset.revision,
    policy: {
      policyVisibleFields: input.taskset.policy.policyVisibleFields,
      privilegedFields: input.taskset.policy.privilegedFields,
      hiddenGraderRefs: input.taskset.policy.hiddenGraderRefs,
      connectedAppScopes: input.taskset.policy.connectedAppScopes,
    },
    environment,
    tools,
    capabilities: portableCapabilities(input.taskset),
    tasks: tasks.map(projectPortableTaskRecord),
    graders,
    metadata: input.taskset.metadata.derivedPortableMetadata ?? {
      sourceTasksetId: input.taskset.id,
      sourceTasksetHash: input.taskset.contentHash,
      sourcePackageHash: input.taskset.metadata.sourcePackageHash ?? null,
      environmentResources: input.taskset.environment.resources ?? [],
      ordinaryAuthoring: {
        graderFixtures: input.taskset.graderFixtures,
        judgeCalibrationFixtures: Object.fromEntries(input.taskset.graders
          .filter(grader => grader.kind === "model_judge")
          .map(grader => [grader.id, grader.calibrationFixtureRefs])),
      },
      ...(learning ? { learning } : {}),
      ...(rewardExecution && (input.rewardExecution || embedded) ? { rewardExecution: { binding: rewardExecution.binding, rewards: rewardExecution.rewards } } : {}),
    },
  });
  const draft = input.admittedTasksetRelease
    ? TasksetReleaseSchema.parse(input.admittedTasksetRelease)
    : TasksetReleaseSchema.parse({
      ...tasksetContent,
      contentHash: contentHash(tasksetContent),
    });
  const tasksetRelease = draft.environmentRelease
    ? assertReleaseBindings({ draft, environmentRelease, verifierSetRelease })
    : bindTasksetExecutionReleases({
      taskset: draft,
      environment: environmentRelease,
      verifierSet: verifierSetRelease,
    });
  return { environmentRelease, verifierSetRelease, tasksetRelease };
}

/**
 * Admits a published comparison policy against the exact portable Taskset
 * release it names. A comparison is deliberately not embedded in that release:
 * doing so would create a content-hash cycle between Taskset and comparison.
 */
export function projectPreferenceComparisonRelease(input: {
  tasksetRelease: TasksetRelease;
  preferenceComparison: PreferenceComparisonRelease;
}): PreferenceComparisonRelease {
  if (!verifyPreferenceComparisonRelease(input.preferenceComparison)) {
    throw new Error("Preference comparison release failed immutable content verification.");
  }
  const release = input.preferenceComparison;
  if (
    release.tasksetRelease.id !== input.tasksetRelease.id
    || release.tasksetRelease.contentHash !== input.tasksetRelease.contentHash
  ) {
    throw new Error("Preference comparison release must reference the admitted portable Taskset release.");
  }
  return release;
}

export function portableTasksetEnvironment(taskset: Taskset): EnvironmentContract {
  return portableEnvironment(taskset);
}

export function portableTasksetTools(taskset: Taskset): ToolDeclaration[] {
  return portableTools(taskset);
}

/** Preserve immutable file/schema references while overlaying current edits. */
export function projectPortableTaskRecord(task: TaskDataRecord) {
  const admitted = task.metadata.portableTaskRecord;
  if (admitted !== undefined) {
    const original = TaskRecordSchema.parse(admitted);
    const projected = TaskRecordSchema.parse({
      ...original,
      id: task.id,
      clusterKey: task.clusterKey,
      split: task.split,
      input: task.input,
      expectedOutput: portableExpectedOutput(task),
      policyVisibleContext: task.policyVisibleContext,
      privilegedContextRef: task.privilegedContextRef,
      tags: task.tags,
      artifactRefs: task.assets === undefined ? original.artifactRefs : task.assets.map((asset) => {
        const previous = original.artifactRefs.find(item => item.id === asset.id);
        return {
          id: asset.id,
          path: previous?.path ?? `tasks/${segment(task.id)}/${segment(asset.fileName)}`,
          contentHash: hash(asset.sha256),
          sizeBytes: asset.sizeBytes,
          mediaType: asset.mediaType,
          visibility: previous?.visibility ?? "policy",
        };
      }),
      requiredOutputs: task.requiredOutputs === undefined ? original.requiredOutputs : task.requiredOutputs.map((output) => {
        const previous = original.requiredOutputs?.find(item => item.path === output.path);
        return {
          path: output.path,
          mediaType: output.mediaType,
          schemaRef: previous?.schemaRef && previous.schemaRef.id === output.schemaRef ? previous.schemaRef : null,
          maxBytes: output.maxBytes ?? null,
          metadata: {
            ...output.metadata,
            ...(output.schemaRef && previous?.schemaRef?.id !== output.schemaRef
              ? { legacySchemaRef: output.schemaRef }
              : {}),
          },
        };
      }),
    });
    if (projected.requiredOutputs === undefined) delete projected.requiredOutputs;
    return projected;
  }
  return {
    id: task.id,
    clusterKey: task.clusterKey,
    split: task.split,
    input: task.input,
    expectedOutput: portableExpectedOutput(task),
    policyVisibleContext: task.policyVisibleContext,
    privilegedContextRef: task.privilegedContextRef,
    artifactRefs: (task.assets ?? []).map((item) => ({
      id: item.id,
      path: `tasks/${segment(task.id)}/${segment(item.fileName)}`,
      contentHash: hash(item.sha256),
      sizeBytes: item.sizeBytes,
      mediaType: item.mediaType,
      visibility: "policy" as const,
    })),
    requiredOutputs: (task.requiredOutputs ?? []).map((output) => ({
      path: output.path,
      mediaType: output.mediaType,
      schemaRef: null,
      maxBytes: output.maxBytes ?? null,
      metadata: {
        ...output.metadata,
        legacySchemaRef: output.schemaRef ?? null,
      },
    })),
    tags: task.tags,
  };
}

function portableExpectedOutput(
  task: TaskDataRecord,
): Record<string, unknown> | null {
  if (!task.expectedOutput) return null;
  if ("artifactRenderer" in task.expectedOutput) {
    throw new Error(
      `Task ${task.id} embeds an artifact renderer. Put shared renderer configuration in Environment resources and reference it from the Scenario.`,
    );
  }
  return task.expectedOutput;
}

function portableEnvironment(taskset: Taskset): EnvironmentContract {
  const kind: EnvironmentContract["kind"] = taskset.environment.kind === "chat"
    ? "text"
    : taskset.environment.kind === "work" ? "work"
      : taskset.environment.kind === "program" ? "custom_program" : "agent";
  return {
    protocolVersion: "openpond.environment.v1",
    kind,
    entrypoint: taskset.environment.entrypoint,
    stateful: taskset.environment.stateful,
    deterministicSeeds: taskset.environment.deterministicSeeds,
    lifecycle: ["create", "reset", "step", "collect", "destroy"],
    networkPolicy: taskset.environment.networkPolicy,
    defaultTimeoutMs: taskset.environment.defaultTimeoutMs,
  };
}

function portableTools(taskset: Taskset): ToolDeclaration[] {
  const admitted = taskset.environment.metadata.portableTools;
  if (admitted !== undefined) {
    return ToolDeclarationSchema.array().max(200).parse(admitted);
  }
  const bindings = taskset.environment.actionBindings ?? [];
  if (bindings.length) return bindings.map((binding) => ({
    name: binding.modelToolName,
    description: binding.description,
    inputSchema: binding.inputSchema,
    inputSchemaHash: hash(binding.actionSchemaHash),
    sideEffect: binding.sideEffect,
    timeoutMs: binding.timeoutMs,
  }));
  return taskset.environment.toolNames.map((name) => ({
    name,
    description: `Host-provided ${name} tool.`,
    inputSchema: {},
    inputSchemaHash: contentHash({}),
    sideEffect: "write" as const,
    timeoutMs: taskset.environment.defaultTimeoutMs,
  }));
}

function portableGrader(grader: GraderSpec): PortableGraderSpec {
  const base = {
    id: grader.id,
    version: grader.version,
    weight: grader.weight,
    hardGate: grader.hardGate,
    rewardEligible: grader.rewardEligible,
    privileged: grader.privileged,
  };
  if (grader.kind === "model_judge") return {
    ...base,
    kind: "model_judge",
    rubricRef: rubricAsset(grader),
    model: modelJudgeRef(grader),
    temperature: grader.temperature,
    calibrationStatus: grader.calibrationStatus,
  };
  if (grader.kind === "custom_verifier") return {
    ...base,
    kind: "custom_verifier",
    verifierRef: grader.metadata.portableVerifierRef === undefined
      ? asset({
          id: `verifier-${grader.id}`,
          path: `graders/${segment(grader.id)}/verifier.json`,
          hashInput: { module: grader.module, exportName: grader.exportName },
          mediaType: "application/json",
          visibility: "host_private",
        })
      : ImmutableAssetRefSchema.parse(grader.metadata.portableVerifierRef),
    timeoutMs: grader.timeoutMs,
    exportName: grader.exportName,
    networkPolicy: "none",
  };
  if (grader.kind === "human") return {
    ...base,
    kind: "human",
    rubricRef: rubricAsset(grader),
    reviewerRole: grader.reviewerRole,
  };
  return {
    ...base,
    kind: grader.kind === "file" ? "artifact"
      : grader.kind === "diff" || grader.kind === "test" ? "state"
        : grader.kind,
    config: grader.config,
  };
}

function portableCapabilities(taskset: Taskset) {
  const admitted = taskset.metadata.portableCapabilities;
  if (admitted !== undefined) {
    return CapabilityRequirementSchema.array().max(200).parse(admitted);
  }
  return [
    ...(taskset.capabilities.requiresTools
      ? [{ id: "tools", required: true, scopes: taskset.environment.toolNames }]
      : []),
    ...(taskset.capabilities.requiresState
      ? [{ id: "local-state", required: true, scopes: [] }]
      : []),
    ...(taskset.capabilities.requiresPrivilegedGrading
      ? [{ id: "private-verifier", required: true, scopes: taskset.policy.hiddenGraderRefs }]
      : []),
    ...taskset.policy.connectedAppScopes.map((scope) => ({
      id: `connected-app-${segment(scope)}`,
      required: true,
      scopes: [scope],
    })),
  ].map((requirement) => ({
    ...requirement,
    portability: requirement.id === "local-state" ? "host_adapter" as const : "portable" as const,
  }));
}

function assertReleaseBindings(input: {
  draft: TasksetRelease;
  environmentRelease: ReturnType<typeof createEnvironmentRelease>;
  verifierSetRelease: ReturnType<typeof createVerifierSetRelease>;
}): TasksetRelease {
  if (
    input.draft.environmentRelease?.id !== input.environmentRelease.id
    || input.draft.environmentRelease.contentHash !== input.environmentRelease.contentHash
  ) {
    throw new Error("Admitted Taskset Release binds a different Environment Release.");
  }
  if (
    input.draft.verifierSetRelease?.id !== input.verifierSetRelease.id
    || input.draft.verifierSetRelease.contentHash !== input.verifierSetRelease.contentHash
  ) {
    throw new Error("Admitted Taskset Release binds a different Verifier Set Release.");
  }
  if (contentHash(input.draft.environment) !== contentHash(input.environmentRelease.contract)) {
    throw new Error("Admitted Taskset Environment differs from its bound Environment Release.");
  }
  if (contentHash(input.draft.graders) !== contentHash(input.verifierSetRelease.graders)) {
    throw new Error("Admitted Taskset graders differ from its bound Verifier Set Release.");
  }
  return input.draft;
}

function modelJudgeRef(grader: Extract<GraderSpec, { kind: "model_judge" }>) {
  const previous = grader.metadata.portableGrader === undefined ? null : PortableGraderSpecSchema.parse(grader.metadata.portableGrader);
  const revision = previous?.kind === "model_judge" && previous.model?.providerId === grader.judge.providerId && previous.model.modelId === grader.judge.modelId ? previous.model.revision : null;
  return { ...grader.judge, revision };
}

function rubricAsset(grader: Extract<GraderSpec, { kind: "human" | "model_judge" }>): ImmutableAssetRef {
  const contentHash = sha256(grader.rubric);
  const sizeBytes = Buffer.byteLength(grader.rubric, "utf8");
  const reference = grader.metadata.portableRubricRef;
  if (reference !== undefined) {
    const asset = ImmutableAssetRefSchema.parse(reference);
    if (asset.contentHash !== contentHash || asset.sizeBytes !== sizeBytes || asset.visibility === "policy") throw new Error("Taskset rubric differs from its published private source.");
    return asset;
  }
  return { id: `rubric-${grader.id}`, path: `graders/${segment(grader.id)}/rubric.md`, contentHash, sizeBytes, mediaType: "text/markdown", visibility: "verifier" };
}

function asset(input: {
  id: string;
  path: string;
  hashInput: unknown;
  mediaType: string;
  visibility: ImmutableAssetRef["visibility"];
}): ImmutableAssetRef {
  return {
    id: input.id,
    path: input.path,
    contentHash: contentHash(input.hashInput),
    sizeBytes: Buffer.byteLength(canonicalJson(input.hashInput)),
    mediaType: input.mediaType,
    visibility: input.visibility,
  };
}

function hash(value: string): string {
  return /^[a-f0-9]{64}$/.test(value) ? value : contentHash(value);
}

function segment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "asset";
}
