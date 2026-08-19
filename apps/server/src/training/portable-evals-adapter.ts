import {
  AttemptOutcomeClassSchema,
  AttemptReceiptSchema,
  FailureOwnerSchema,
  buildArtifactManifest,
  createCanonicalRolloutRecord,
  createAttemptReceipt,
  createRewardReceipt,
  createRunManifest,
  classifyAttemptOutcome,
  verifyRequiredOutputs,
  type CollectedArtifact,
  type CanonicalRolloutRecord,
  type ArtifactManifest,
  type AttemptReceipt,
  type EnvironmentRelease,
  type GraderSpec as PortableGraderSpec,
  type RewardComponentReceipt,
  type RewardReceipt,
  type RunManifest,
  type TasksetRelease,
  type VerifierSetRelease,
  type OptimizerTrainingSample,
} from "@openpond/evals";
import {
  materializePortableTasksetRelease,
  portableTasksetEnvironment,
  portableTasksetTools,
} from "@openpond/taskset-sdk";
import {
  AgentSnapshotSchema,
  HarnessReleaseSchema,
  canonicalJson,
  contentHash,
  createAgentSnapshot,
  createHarnessRelease,
  type AgentSnapshot,
  type FailureClass,
  type HarnessRelease,
  type ImmutableArtifactRef,
  type ImmutableAssetRef,
  type ToolDeclaration,
} from "@openpond/harness";
import type {
  ChatModelRef,
  GradeComponent,
  GradeResult,
  OpenPondProfileState,
  TaskAttemptArtifact,
  TaskAttemptResult,
  TaskDataRecord,
  Taskset,
} from "@openpond/contracts";

export type DesktopHarnessContext = {
  agentSnapshot: AgentSnapshot;
  harnessRelease: HarnessRelease;
  environmentRelease: EnvironmentRelease;
  verifierSetRelease: VerifierSetRelease;
  tasksetRelease: TasksetRelease;
  runManifest: RunManifest;
};

export function compileDesktopHarnessContext(input: {
  taskset: Taskset;
  selectedTask?: TaskDataRecord;
  profile?: OpenPondProfileState | null;
  releasedHarness?: Pick<DesktopHarnessContext, "agentSnapshot" | "harnessRelease"> | null;
  tasksetRelease?: TasksetRelease | null;
  reasoningEffort?: string | null;
  model: ChatModelRef;
  now?: () => string;
}): DesktopHarnessContext {
  const tasksetTools = portableTasksetTools(input.taskset);
  const { agentSnapshot, harnessRelease } = input.releasedHarness
    ? {
        agentSnapshot: AgentSnapshotSchema.parse(input.releasedHarness.agentSnapshot),
        harnessRelease: HarnessReleaseSchema.parse(input.releasedHarness.harnessRelease),
      }
    : compileTemporaryProfileHarness(input.taskset, input.profile);
  if (
    harnessRelease.agentSnapshot.id !== agentSnapshot.id ||
    harnessRelease.agentSnapshot.contentHash !== agentSnapshot.contentHash
  ) {
    throw new Error("Released Harness does not bind the supplied Agent snapshot.");
  }
  const environment = portableTasksetEnvironment(input.taskset);
  const sourceTasks = input.taskset.tasks.length
    ? input.taskset.tasks
    : input.selectedTask ? [input.selectedTask] : [];
  if (!sourceTasks.length) throw new Error("A portable Taskset release requires at least one resolved task.");
  const {
    environmentRelease,
    verifierSetRelease,
    tasksetRelease,
  } = materializePortableTasksetRelease({
    taskset: input.taskset,
    selectedTasks: sourceTasks,
    adapterId: desktopTasksetRuntimeAdapterId(input.taskset),
    admittedTasksetRelease: input.tasksetRelease,
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
      adapterId: desktopTasksetRuntimeAdapterId(input.taskset),
      placement: "local",
      runtimeVersion: "desktop-v1",
      capabilityReceipt: contentHash({ environment, tools: tasksetTools, capabilities: input.taskset.capabilities }),
    },
    limits: {
      maxTurns: environment.limits?.maxToolTurns ?? 128,
      timeoutMs: input.taskset.environment.defaultTimeoutMs,
      maxOutputBytes: 250_000_000,
      maximumSpendUsd: null,
    },
    approval: null,
    createdAt: now(),
    metadata: {
      sourceTasksetId: input.taskset.id,
      sourceTasksetRevision: input.taskset.revision,
      reasoningEffort: input.reasoningEffort ?? null,
    },
  });
  return {
    agentSnapshot,
    harnessRelease,
    environmentRelease,
    verifierSetRelease,
    tasksetRelease,
    runManifest,
  };
}

function compileTemporaryProfileHarness(
  taskset: Taskset,
  profile: OpenPondProfileState | null | undefined,
): Pick<DesktopHarnessContext, "agentSnapshot" | "harnessRelease"> {
  // Temporary migration adapter only. Harness workspaces supply an already
  // compiled immutable release and bypass every Profile read in this function.
  const harnessTools: ToolDeclaration[] = [];
  const sourceRelease = taskset.profileRelease
    ? { id: taskset.profileRelease.id, contentHash: hash(taskset.profileRelease.contentHash) }
    : profile?.git?.head
      ? { id: `source-${segment(profile.git.head)}`, contentHash: hash(profile.git.head) }
      : null;
  const skills = portableSkills(profile);
  const agents = portableAgents(profile);
  const dependencyLock = asset({
    id: "desktop-dependency-lock",
    path: ".openpond/harness/dependency-lock.json",
    hashInput: {
      profileHead: profile?.git?.head ?? null,
      sourceRelease,
      tools: harnessTools,
      skills: skills.map(({ id, contentHash: assetHash }) => ({ id, contentHash: assetHash })),
      agents: agents.map(({ id, contentHash: assetHash }) => ({ id, contentHash: assetHash })),
    },
    mediaType: "application/json",
    visibility: "policy",
  });
  const agentSnapshot = createAgentSnapshot({
    schemaVersion: "openpond.agentSnapshot.v2",
    id: `agent-snapshot-${contentHash([sourceRelease, harnessTools, dependencyLock.contentHash]).slice(0, 24)}`,
    sourceRelease,
    instructions: [],
    skills,
    agents,
    toolDeclarations: harnessTools,
    capabilityRequirements: [],
    dependencyLock,
    portability: {
      portable: true,
      blockers: [],
      localOnlyAssetRefs: [],
      hostPrivateAssetRefs: [],
    },
    metadata: { sourceReleaseId: sourceRelease?.id ?? null },
  });
  const program = asset({
    id: "desktop-harness-program",
    path: ".openpond/harness/program.json",
    hashInput: { program: "openpond.desktop-agent-loop.v1" },
    mediaType: "application/json",
    visibility: "policy",
  });
  const harnessRelease = createHarnessRelease({
    schemaVersion: "openpond.harnessRelease.v2",
    id: `harness-${contentHash([agentSnapshot.contentHash, program.contentHash, harnessTools]).slice(0, 24)}`,
    agentSnapshot: { id: agentSnapshot.id, contentHash: agentSnapshot.contentHash },
    program,
    tools: harnessTools,
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
      privilegedEvidence: ["expected_output", "private_verifier"],
      privateVerifierIsolation: true,
    },
    files: [...skills, ...agents],
    metadata: { runtimeProtocol: "openpond.desktop-agent-loop.v1" },
  });
  return { agentSnapshot, harnessRelease };
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
      usage: input.attempt.metadata.usage ?? [],
    },
  }));
}

export function projectDesktopCanonicalReceipts(input: {
  context: Pick<DesktopHarnessContext, "runManifest" | "tasksetRelease" | "verifierSetRelease">;
  attempt: TaskAttemptResult;
  grade: GradeResult;
  artifacts: TaskAttemptArtifact[];
}): {
  attemptReceipt: AttemptReceipt;
  artifactManifest: ArtifactManifest;
  rewardReceipt: RewardReceipt;
} {
  const attemptReceipt = projectDesktopAttemptReceipt({
    manifest: input.context.runManifest,
    attempt: input.attempt,
    grade: input.grade,
    artifacts: input.artifacts,
  });
  const task = input.context.tasksetRelease.tasks.find(
    (candidate) => candidate.id === input.attempt.taskId,
  );
  if (!task) throw new Error(`Task ${input.attempt.taskId} is absent from the admitted Taskset Release.`);
  const requiredOutputs = task.requiredOutputs ?? [];
  const outputArtifacts: CollectedArtifact[] = input.artifacts
    .filter((artifact) => artifact.kind === "output_artifact")
    .map((artifact) => ({
      path: typeof artifact.metadata.requiredOutputPath === "string"
        ? artifact.metadata.requiredOutputPath
        : artifact.path,
      artifact: portableArtifact(artifact),
      detectedMediaType: artifact.mediaType ?? null,
      status: "collected" as const,
      parseStatus: artifactValidationStatus(artifact.metadata.parseStatus),
      schemaStatus: artifactValidationStatus(artifact.metadata.schemaStatus),
      evidenceRefs: [portableArtifact(artifact)],
      metadata: { sourceArtifactId: artifact.id },
    }));
  const artifactManifest = buildArtifactManifest({
    id: `artifact-manifest-${attemptReceipt.id}`,
    attemptRef: { id: attemptReceipt.id, contentHash: attemptReceipt.contentHash },
    requiredOutputs,
    collectedArtifacts: outputArtifacts,
    createdAt: input.attempt.completedAt,
    metadata: { legacyAttemptRef: input.attempt.id },
  });
  const gradeComponents = input.grade.components.map((component, index) =>
    portableRewardComponent({
      component,
      grader: input.context.verifierSetRelease.graders.find(
        (candidate) => candidate.id === component.graderId,
      ),
      evidenceRef: attemptReceipt.graderEvidenceRefs[index] ?? null,
      gradeScored: input.grade.score !== null,
    }),
  );
  const outputComponents = verifyRequiredOutputs({ requiredOutputs, manifest: artifactManifest });
  const initial = canonicalOutcome(input.attempt, input.grade);
  const collectorFailure = outputComponents.some(
    (component) => component.status === "unscorable" && component.failureOwner === "collector",
  );
  const missingOrInvalidOutput = outputComponents.some(
    (component) => component.status === "scored" && !component.passed,
  );
  const outcome = initial.outcomeClass === "completed" && collectorFailure
    ? { outcomeClass: "collector_failure" as const, failureOwner: "collector" as const }
    : initial.outcomeClass === "completed" && missingOrInvalidOutput
      ? { outcomeClass: "incomplete_output" as const, failureOwner: "policy" as const }
      : initial;
  const rewardReceipt = createRewardReceipt({
    id: `reward-${contentHash([
      attemptReceipt.contentHash,
      input.context.verifierSetRelease.contentHash,
      artifactManifest.contentHash,
      input.grade.id,
    ]).slice(0, 24)}`,
    attemptRef: { id: attemptReceipt.id, contentHash: attemptReceipt.contentHash },
    verifierSet: input.context.verifierSetRelease,
    artifactManifest,
    ...outcome,
    components: [...gradeComponents, ...outputComponents],
    createdAt: input.grade.createdAt,
    metadata: {
      legacyGradeRef: input.grade.id,
      legacyAttemptRef: input.attempt.id,
    },
  });
  return { attemptReceipt, artifactManifest, rewardReceipt };
}

export function projectDesktopCanonicalRollout(input: {
  context: DesktopHarnessContext;
  attempt: TaskAttemptResult;
  artifacts: TaskAttemptArtifact[];
  canonical: {
    attemptReceipt: AttemptReceipt;
    artifactManifest: ArtifactManifest;
    rewardReceipt: RewardReceipt;
  };
  optimizerSample?: OptimizerTrainingSample | null;
}): CanonicalRolloutRecord {
  const traceArtifact = input.artifacts.find((artifact) => artifact.kind === "runtime_trace")
    ?? input.artifacts.find((artifact) => artifact.kind === "raw_model_response");
  const traceRef: ImmutableArtifactRef = traceArtifact
    ? portableArtifact(traceArtifact)
    : {
        id: `trace-${input.canonical.attemptReceipt.id}`,
        contentHash: input.canonical.attemptReceipt.traceHash,
        mediaType: "application/vnd.openpond.attempt-trace+json",
        sizeBytes: null,
      };
  const timedOut = input.canonical.rewardReceipt.outcomeClass === "task_deadline"
    || input.canonical.rewardReceipt.outcomeClass === "infrastructure_timeout";
  const cancelled = input.canonical.rewardReceipt.outcomeClass === "cancelled";
  return createCanonicalRolloutRecord({
    id: `rollout-${contentHash([
      input.canonical.attemptReceipt.contentHash,
      input.canonical.rewardReceipt.contentHash,
      traceRef.contentHash,
    ]).slice(0, 24)}`,
    attemptReceipt: input.canonical.attemptReceipt,
    rewardReceipt: input.canonical.rewardReceipt,
    artifactManifestRef: {
      id: input.canonical.artifactManifest.id,
      contentHash: input.canonical.artifactManifest.contentHash,
    },
    tasksetRelease: {
      id: input.context.tasksetRelease.id,
      contentHash: input.context.tasksetRelease.contentHash,
    },
    environmentRelease: {
      id: input.context.environmentRelease.id,
      contentHash: input.context.environmentRelease.contentHash,
    },
    harnessRelease: {
      id: input.context.harnessRelease.id,
      contentHash: input.context.harnessRelease.contentHash,
    },
    taskId: input.attempt.taskId,
    split: input.attempt.split,
    model: input.context.runManifest.model,
    seed: String(input.attempt.seed),
    traceRef,
    optimizerSample: input.optimizerSample ?? null,
    environmentExecutions: [{
      id: `environment-execution-${input.attempt.id}`,
      environmentRelease: {
        id: input.context.environmentRelease.id,
        contentHash: input.context.environmentRelease.contentHash,
      },
      status: cancelled
        ? "cancelled"
        : timedOut
          ? "timed_out"
          : input.canonical.rewardReceipt.status === "scored"
            ? "completed"
            : "failed",
      startedAt: input.attempt.startedAt,
      completedAt: input.attempt.completedAt,
      traceRefs: [traceRef],
      metadata: {
        legacyAttemptRef: input.attempt.id,
        runtimeEventCount: input.attempt.runtimeEventRefs.length,
      },
    }],
    startedAt: input.attempt.startedAt,
    completedAt: input.attempt.completedAt,
    metadata: {
      source: "openpond.desktop-local-runtime",
      optimizerSamplePresent: Boolean(input.optimizerSample),
    },
  });
}

function portableRewardComponent(input: {
  component: GradeComponent;
  grader: PortableGraderSpec | undefined;
  evidenceRef: ImmutableArtifactRef | null;
  gradeScored: boolean;
}): RewardComponentReceipt {
  if (!input.grader) {
    throw new Error(`Grade component ${input.component.graderId} has no admitted Verifier definition.`);
  }
  const status = input.gradeScored ? "scored" as const : "unscorable" as const;
  const rewardEligible = status === "scored" && input.component.rewardEligible;
  const evidenceRefs = input.evidenceRef ? [input.evidenceRef] : [];
  return {
    verifierId: input.component.graderId,
    verifierVersion: input.component.graderVersion,
    status,
    rawScore: status === "scored" ? input.component.score : null,
    normalizedScore: status === "scored" ? input.component.score : null,
    weight: input.grader.weight,
    passed: input.component.passed,
    hardGate: input.component.hardGate,
    rewardEligible,
    rewardContribution: rewardEligible ? input.component.score : null,
    failureOwner: input.component.passed
      ? null
      : status === "scored" ? "policy" : "verifier",
    feedback: input.component.feedback ? [input.component.feedback] : [],
    visibleEvidenceRefs: input.grader.privileged ? [] : evidenceRefs,
    privilegedEvidenceRefs: input.grader.privileged ? evidenceRefs : [],
    metadata: {
      judge: input.component.judge ?? null,
      calibrationStatus: input.component.calibrationStatus,
      legacyEvidenceRefs: input.component.evidenceRefs,
    },
  };
}

function canonicalOutcome(
  attempt: TaskAttemptResult,
  grade: GradeResult,
): {
  outcomeClass: import("@openpond/evals").AttemptOutcomeClass;
  failureOwner: import("@openpond/evals").FailureOwner | null;
} {
  const explicitOutcome = AttemptOutcomeClassSchema.safeParse(attempt.metadata.outcomeClass);
  if (explicitOutcome.success) {
    const explicitOwner = attempt.metadata.failureOwner === null
      ? null
      : FailureOwnerSchema.safeParse(attempt.metadata.failureOwner);
    if (explicitOwner !== null && !explicitOwner.success) {
      throw new Error("Attempt has an invalid explicit failure owner.");
    }
    return {
      outcomeClass: explicitOutcome.data,
      failureOwner: explicitOwner === null ? null : explicitOwner.data,
    };
  }
  const failureClass = attemptFailureClass(attempt, grade);
  if (failureClass) {
    return classifyAttemptOutcome({
      failureClass,
      timeoutKind: attempt.metadata.timeoutKind === "task_deadline"
        ? "task_deadline"
        : "infrastructure_timeout",
    });
  }
  if (grade.score === null) {
    return { outcomeClass: "verifier_failure", failureOwner: "verifier" };
  }
  if (!grade.passed) {
    return { outcomeClass: "policy_failure", failureOwner: "policy" };
  }
  return { outcomeClass: "completed", failureOwner: null };
}

function artifactValidationStatus(
  value: unknown,
): "not_requested" | "passed" | "failed" {
  return value === "passed" || value === "failed" ? value : "not_requested";
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

function portableAgents(profile?: OpenPondProfileState | null): ImmutableAssetRef[] {
  const releases = new Map<string, string>();
  for (const agent of profile?.agents ?? []) {
    if (agent.enabled) releases.set(agent.id, contentHash({ name: agent.name, path: agent.path }));
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

export function desktopTasksetRuntimeAdapterId(taskset: Taskset): string {
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
