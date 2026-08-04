import {
  AttemptReceiptSchema,
  TasksetReleaseSchema,
  canonicalJson,
  contentHash,
  createAgentSnapshot,
  createAttemptReceipt,
  createHarnessRelease,
  createRunManifest,
  type AgentSnapshot,
  type AttemptReceipt,
  type EnvironmentContract,
  type FailureClass,
  type GraderSpec as PortableGraderSpec,
  type HarnessRelease,
  type ImmutableArtifactRef,
  type ImmutableAssetRef,
  type RunManifest,
  type TasksetRelease,
  type ToolDeclaration,
} from "@openpond/evals";
import type {
  ChatModelRef,
  GradeResult,
  GraderSpec,
  OpenPondProfileState,
  TaskAttemptArtifact,
  TaskAttemptResult,
  TaskDataRecord,
  Taskset,
} from "@openpond/contracts";

export type DesktopHarnessContext = {
  agentSnapshot: AgentSnapshot;
  harnessRelease: HarnessRelease;
  tasksetRelease: TasksetRelease;
  runManifest: RunManifest;
};

export function compileDesktopHarnessContext(input: {
  taskset: Taskset;
  selectedTask?: TaskDataRecord;
  profile?: OpenPondProfileState | null;
  model: ChatModelRef;
  now?: () => string;
}): DesktopHarnessContext {
  const tools = portableTools(input.taskset);
  const profileRelease = input.taskset.profileRelease
    ? { id: input.taskset.profileRelease.id, contentHash: hash(input.taskset.profileRelease.contentHash) }
    : null;
  const skills = portableSkills(input.profile);
  const agents = portableAgents(input.taskset);
  const dependencyLock = asset({
    id: "desktop-dependency-lock",
    path: ".openpond/harness/dependency-lock.json",
    hashInput: {
      profileHead: input.profile?.git?.head ?? null,
      profileRelease,
      tools,
      skills: skills.map(({ id, contentHash: assetHash }) => ({ id, contentHash: assetHash })),
      agents: agents.map(({ id, contentHash: assetHash }) => ({ id, contentHash: assetHash })),
    },
    mediaType: "application/json",
    visibility: "policy",
  });
  const portabilityBlockers = [...input.taskset.capabilities.portabilityBlockers];
  const agentSnapshot = createAgentSnapshot({
    schemaVersion: "openpond.agentSnapshot.v1",
    id: `agent-snapshot-${contentHash([input.taskset.profileId, profileRelease, tools, dependencyLock.contentHash]).slice(0, 24)}`,
    profileRelease,
    instructions: [],
    skills,
    agents,
    toolDeclarations: tools,
    capabilityRequirements: capabilityRequirements(input.taskset),
    dependencyLock,
    portability: {
      portable: input.taskset.capabilities.exportable && portabilityBlockers.length === 0,
      blockers: portabilityBlockers,
      localOnlyAssetRefs: input.taskset.capabilities.exportable ? [] : agents.map((item) => item.id),
      hostPrivateAssetRefs: [],
    },
    metadata: {
      sourceProfileId: input.taskset.profileId,
      sourceTasksetHash: input.taskset.contentHash,
    },
  });
  const environment = portableEnvironment(input.taskset);
  const program = asset({
    id: "desktop-harness-program",
    path: ".openpond/harness/program.json",
    hashInput: {
      environment,
      actionBindings: input.taskset.environment.actionBindings ?? [],
      adapterId: runtimeAdapterId(input.taskset),
    },
    mediaType: "application/json",
    visibility: "policy",
  });
  const harnessRelease = createHarnessRelease({
    schemaVersion: "openpond.harnessRelease.v1",
    id: `harness-${contentHash([agentSnapshot.contentHash, program.contentHash, environment, tools]).slice(0, 24)}`,
    agentSnapshot: { id: agentSnapshot.id, contentHash: agentSnapshot.contentHash },
    program,
    environment,
    tools,
    lifecycle: {
      create: true,
      reset: true,
      step: true,
      collect: true,
      destroy: true,
      resetScope: "attempt",
    },
    graderInterface: {
      visibleEvidence: ["output", "runtime_events", "artifacts"],
      privilegedEvidence: input.taskset.graders.some((grader) => grader.privileged)
        ? ["expected_output", "private_verifier"]
        : [],
      privateVerifierIsolation: input.taskset.capabilities.requiresPrivilegedGrading,
    },
    policy: {
      policyVisibleFields: input.taskset.policy.policyVisibleFields,
      privilegedFields: input.taskset.policy.privilegedFields,
      hiddenGraderRefs: input.taskset.policy.hiddenGraderRefs,
      connectedAppScopes: input.taskset.policy.connectedAppScopes,
    },
    files: [...skills, ...agents],
    metadata: {
      runtimeAdapterId: runtimeAdapterId(input.taskset),
      sourceTasksetHash: input.taskset.contentHash,
    },
  });
  const sourceTasks = input.taskset.tasks.length
    ? input.taskset.tasks
    : input.selectedTask ? [input.selectedTask] : [];
  if (!sourceTasks.length) throw new Error("A portable Taskset release requires at least one resolved task.");
  const tasksetContent = {
    schemaVersion: "openpond.tasksetRelease.v1" as const,
    id: `taskset-release-${input.taskset.id}-r${input.taskset.revision}`,
    revision: input.taskset.revision,
    harnessRelease: { id: harnessRelease.id, contentHash: harnessRelease.contentHash },
    policy: harnessRelease.policy,
    environment,
    tools,
    capabilities: portableCapabilities(input.taskset),
    tasks: sourceTasks.map((task) => ({
      id: task.id,
      clusterKey: task.clusterKey,
      split: task.split,
      input: task.input,
      expectedOutput: task.expectedOutput,
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
      tags: task.tags,
    })),
    graders: input.taskset.graders.map(portableGrader),
    metadata: {
      sourceTasksetId: input.taskset.id,
      sourceTasksetHash: input.taskset.contentHash,
    },
  };
  const tasksetRelease = TasksetReleaseSchema.parse({
    ...tasksetContent,
    contentHash: contentHash(tasksetContent),
  });
  const now = input.now ?? (() => new Date().toISOString());
  const runManifest = createRunManifest({
    schemaVersion: "openpond.runManifest.v1",
    id: `run-manifest-${contentHash([harnessRelease.contentHash, tasksetRelease.contentHash, input.model]).slice(0, 24)}`,
    harnessRelease: { id: harnessRelease.id, contentHash: harnessRelease.contentHash },
    tasksetRelease: { id: tasksetRelease.id, contentHash: tasksetRelease.contentHash },
    model: {
      provider: input.model.providerId,
      model: input.model.modelId,
      revision: null,
      artifactHash: null,
      tokenizerRevision: null,
      chatTemplateHash: null,
    },
    runtimeTarget: {
      adapterId: runtimeAdapterId(input.taskset),
      placement: "local",
      runtimeVersion: "desktop-v1",
      capabilityReceipt: contentHash({ environment, tools, capabilities: input.taskset.capabilities }),
    },
    limits: {
      maxTurns: 128,
      timeoutMs: input.taskset.environment.defaultTimeoutMs,
      maxOutputBytes: 250_000_000,
      maximumSpendUsd: null,
    },
    approval: null,
    createdAt: now(),
    metadata: {
      sourceTasksetId: input.taskset.id,
      sourceTasksetRevision: input.taskset.revision,
    },
  });
  return { agentSnapshot, harnessRelease, tasksetRelease, runManifest };
}

export function projectDesktopAttemptReceipt(input: {
  manifest: RunManifest;
  attempt: TaskAttemptResult;
  grade: GradeResult;
  artifacts: TaskAttemptArtifact[];
}): AttemptReceipt {
  const artifacts = input.artifacts.map(portableArtifact);
  const traceArtifact = input.artifacts.find((artifact) => artifact.kind === "runtime_trace")
    ?? input.artifacts.find((artifact) => artifact.kind === "raw_model_response");
  const failureClass = attemptFailureClass(input.attempt, input.grade);
  const graderEvidenceRefs: ImmutableArtifactRef[] = input.grade.components.map((component) => ({
    id: `grader-${segment(component.graderId)}-${input.grade.id}`,
    contentHash: contentHash(component),
    mediaType: "application/vnd.openpond.grader-evidence+json",
    sizeBytes: Buffer.byteLength(canonicalJson(component)),
  }));
  return AttemptReceiptSchema.parse(createAttemptReceipt({
    schemaVersion: "openpond.attemptReceipt.v1",
    id: `receipt-${contentHash([input.manifest.contentHash, input.attempt.id, input.grade.id]).slice(0, 24)}`,
    runManifest: { id: input.manifest.id, contentHash: input.manifest.contentHash },
    taskId: input.attempt.taskId,
    seed: String(input.attempt.seed),
    terminal: !["infrastructure_failure", "timeout", "cancelled"].includes(failureClass ?? ""),
    failureClass,
    outputHash: input.attempt.infrastructureError ? null : contentHash(input.attempt.output),
    traceHash: traceArtifact ? hash(traceArtifact.sha256) : contentHash({
      attemptId: input.attempt.id,
      output: input.attempt.output,
      runtimeEventRefs: input.attempt.runtimeEventRefs,
      artifactRefs: input.attempt.artifactRefs,
      metadata: input.attempt.metadata,
    }),
    artifactRefs: artifacts,
    graderEvidenceRefs,
    startedAt: input.attempt.startedAt,
    completedAt: input.attempt.completedAt,
    latencyMs: input.attempt.latencyMs,
    costUsd: input.attempt.costUsd,
    legacyAttemptRef: input.attempt.id,
    metadata: {
      legacyGradeRef: input.grade.id,
      rewardEligible: input.grade.rewardEligible,
      score: input.grade.score,
      passed: input.grade.passed,
    },
  }));
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
    rubricRef: asset({ id: `rubric-${grader.id}`, path: `graders/${segment(grader.id)}/rubric.md`, hashInput: grader.rubric, mediaType: "text/markdown", visibility: "verifier" }),
    calibrationStatus: grader.calibrationStatus,
  };
  if (grader.kind === "custom_verifier") return {
    ...base,
    kind: "custom_verifier",
    verifierRef: asset({ id: `verifier-${grader.id}`, path: `graders/${segment(grader.id)}/verifier.json`, hashInput: { module: grader.module, exportName: grader.exportName }, mediaType: "application/json", visibility: "host_private" }),
    timeoutMs: grader.timeoutMs,
    networkPolicy: "none",
  };
  if (grader.kind === "human") return {
    ...base,
    kind: "human",
    rubricRef: asset({ id: `rubric-${grader.id}`, path: `graders/${segment(grader.id)}/rubric.md`, hashInput: grader.rubric, mediaType: "text/markdown", visibility: "verifier" }),
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

function portableSkills(profile?: OpenPondProfileState | null): ImmutableAssetRef[] {
  return (profile?.skills ?? []).filter((skill) => skill.enabled).map((skill) => ({
    id: `skill-${segment(skill.name)}`,
    path: `skills/${segment(skill.name)}/SKILL.md`,
    contentHash: hash(skill.sourceHash),
    sizeBytes: Math.max(0, skill.charCount),
    mediaType: "text/markdown",
    visibility: "policy",
  }));
}

function portableAgents(taskset: Taskset): ImmutableAssetRef[] {
  const releases = new Map<string, string>();
  for (const binding of taskset.environment.actionBindings ?? []) {
    releases.set(binding.agentRelease.id, binding.agentRelease.contentHash);
  }
  return [...releases].map(([id, releaseHash]) => ({
    id: `agent-${segment(id)}`,
    path: `agents/${segment(id)}/release.json`,
    contentHash: hash(releaseHash),
    sizeBytes: 0,
    mediaType: "application/vnd.openpond.agent-release+json",
    visibility: "policy",
  }));
}

function portableCapabilities(taskset: Taskset) {
  const requirements = capabilityRequirements(taskset);
  return requirements.map((requirement) => ({
    ...requirement,
    portability: requirement.id === "local-state" ? "host_adapter" as const : "portable" as const,
  }));
}

function capabilityRequirements(taskset: Taskset) {
  return [
    ...(taskset.capabilities.requiresTools ? [{ id: "tools", required: true, scopes: taskset.environment.toolNames }] : []),
    ...(taskset.capabilities.requiresState ? [{ id: "local-state", required: true, scopes: [] }] : []),
    ...(taskset.capabilities.requiresPrivilegedGrading ? [{ id: "private-verifier", required: true, scopes: taskset.policy.hiddenGraderRefs }] : []),
    ...taskset.policy.connectedAppScopes.map((scope) => ({ id: `connected-app-${segment(scope)}`, required: true, scopes: [scope] })),
  ];
}

function runtimeAdapterId(taskset: Taskset): string {
  const declared = taskset.environment.metadata.runtimeAdapterId;
  if (typeof declared === "string" && declared.trim()) return declared.trim();
  const benchmark = taskset.environment.metadata.benchmark;
  if (benchmark && typeof benchmark === "object" && !Array.isArray(benchmark)) {
    const id = Reflect.get(benchmark, "id");
    if (typeof id === "string" && id.trim()) return `conformance:${id.trim()}`;
  }
  if (taskset.environment.kind === "work") return "openpond:desktop-work";
  if (taskset.environment.kind === "chat") return "openpond:desktop-text";
  return `openpond:${segment(taskset.environment.entrypoint)}`;
}

function portableArtifact(artifact: TaskAttemptArtifact): ImmutableArtifactRef {
  return {
    id: artifact.id,
    contentHash: hash(artifact.sha256),
    mediaType: artifact.mediaType ?? null,
    sizeBytes: artifact.sizeBytes,
  };
}

function attemptFailureClass(attempt: TaskAttemptResult, grade: GradeResult): FailureClass | null {
  if (attempt.infrastructureError) return "infrastructure_failure";
  if (grade.failureClass) return grade.failureClass;
  const declared = attempt.metadata.failureClass;
  return declared === "policy_failure" || declared === "grader_failure"
    || declared === "environment_failure" || declared === "infrastructure_failure"
    || declared === "timeout" || declared === "cancelled" ? declared : null;
}

function asset(input: {
  id: string;
  path: string;
  hashInput: unknown;
  mediaType: string;
  visibility: ImmutableAssetRef["visibility"];
}): ImmutableAssetRef {
  const bytes = canonicalJson(input.hashInput);
  return {
    id: input.id,
    path: input.path,
    contentHash: contentHash(input.hashInput),
    sizeBytes: Buffer.byteLength(bytes),
    mediaType: input.mediaType,
    visibility: input.visibility,
  };
}

function hash(value: string): string {
  return /^[a-f0-9]{64}$/.test(value) ? value : contentHash(value);
}

function segment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "asset";
}
