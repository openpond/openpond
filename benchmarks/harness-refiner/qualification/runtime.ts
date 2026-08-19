import { promises as fs } from "node:fs";
import path from "node:path";

import {
  GradeResultSchema,
  HarnessSourceManifestSchema,
  HarnessWorkspaceSchema,
  TurnSchema,
  createImprovementObservation,
  createImprovementRouteDecision,
  createRefinementTriggerDecision,
  type ChatModelRef,
  type HarnessRefinerOutcome,
  type RefinementTriggerDecision,
  type Session,
  type TaskDataRecord,
  type Taskset,
} from "@openpond/contracts";
import { contentHash, canonicalJson } from "@openpond/harness";

import { ensureLocalHarnessRunOverlay } from
  "../../../apps/server/src/harness/local-harness-run-overlay.js";
import { recordLocalHarnessImprovementBoundary } from
  "../../../apps/server/src/harness/local-harness-improvement-observer.js";
import { loadLocalHarnessRuntimeFromRelease } from
  "../../../apps/server/src/harness/local-harness-skill-runtime.js";
import {
  compileLocalHarnessSource,
  localHarnessWorkspacePaths,
  materializeLocalHarnessRelease,
} from "../../../apps/server/src/harness/local-harness-workspace-service.js";
import type { SqliteStore } from "../../../apps/server/src/store/store.js";
import { persistCanonicalEvaluationEvidence } from
  "../../../apps/server/src/training/canonical-evaluation-persistence.js";
import { benchmarkRefinerRewardPacket } from
  "../../../apps/server/src/training/harness-refiner-benchmark-refiner-stage.js";
import { createLocalTasksetWorkRuntime } from
  "../../../apps/server/src/training/local-taskset-work-runtime.js";
import { compileDesktopHarnessContext } from
  "../../../apps/server/src/training/portable-evals-adapter.js";
import { runTasksetWorkAttempt } from
  "../../../apps/server/src/training/taskset-work-attempt-runner.js";
import { event } from "../../../apps/server/src/utils.js";
import { QualificationModelMeter } from "./model-meter.js";
import { runQualificationRefiner } from "./checkpoint.js";
import {
  HARNESS_REFINER_QUALIFICATION_ID,
  HARNESS_REFINER_QUALIFICATION_MODEL,
  SEEDED_HTML_DEFECT,
} from "./protocol.js";

const NOW = "2026-08-18T16:00:00.000Z";
const LATER = "2026-08-18T16:01:00.000Z";

export type QualificationRuntime = Awaited<ReturnType<typeof loadRuntime>>;
export type QualificationAttempt = Awaited<ReturnType<typeof runQualificationTask>>;

export async function createSeededQualificationWorkspace(input: {
  store: SqliteStore;
  storeDir: string;
  workspaceId: string;
}) {
  return createQualificationWorkspace({
    ...input,
    name: "Harness Refiner qualification",
    instruction: `# Qualification Harness\n\nKeep changes narrow, reusable, and provider-neutral.\n\n${SEEDED_HTML_DEFECT}\n`,
  });
}

export async function createQualificationWorkspace(input: {
  store: SqliteStore;
  storeDir: string;
  workspaceId: string;
  name: string;
  instruction: string;
}) {
  const paths = localHarnessWorkspacePaths(input.storeDir, input.workspaceId);
  await fs.mkdir(path.join(paths.source, "instructions"), { recursive: true });
  const manifest = HarnessSourceManifestSchema.parse({
    schemaVersion: "openpond.harnessSourceManifest.v1",
    name: input.name,
    files: [
      {
        id: "dependency-lock",
        kind: "dependency_lock",
        path: "dependency-lock.json",
        parentId: null,
        mediaType: "application/json",
        visibility: "policy",
        portability: "portable",
      },
      {
        id: "agent-runtime-program",
        kind: "program",
        path: "program.json",
        parentId: null,
        mediaType: "application/json",
        visibility: "policy",
        portability: "portable",
      },
      {
        id: "instruction-system",
        kind: "instruction",
        path: "instructions/system.md",
        parentId: null,
        mediaType: "text/markdown",
        visibility: "policy",
        portability: "portable",
      },
    ],
    toolDeclarations: [],
    capabilityRequirements: [],
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
    runtimeProtocol: "openpond.agent-runtime.v1",
    metadata: { qualificationProtocol: HARNESS_REFINER_QUALIFICATION_ID },
  });
  await Promise.all([
    fs.writeFile(
      path.join(paths.source, "dependency-lock.json"),
      canonicalJson({ dependencies: {} }),
      { flag: "wx" },
    ),
    fs.writeFile(
      path.join(paths.source, "program.json"),
      canonicalJson({ runtimeProtocol: "openpond.agent-runtime.v1" }),
      { flag: "wx" },
    ),
    fs.writeFile(
      path.join(paths.source, "instructions", "system.md"),
      input.instruction,
      { flag: "wx" },
    ),
    fs.writeFile(
      path.join(paths.source, "harness.json"),
      canonicalJson(manifest),
      { flag: "wx" },
    ),
  ]);
  const compiled = await compileLocalHarnessSource({
    workspaceId: input.workspaceId,
    sourceDir: paths.source,
  });
  const release = await materializeLocalHarnessRelease({
    storeDir: input.storeDir,
    workspaceId: input.workspaceId,
    compiled,
    createdAt: NOW,
  });
  const workspace = HarnessWorkspaceSchema.parse({
    schemaVersion: "openpond.harnessWorkspace.v1",
    id: input.workspaceId,
    ownerScope: { kind: "personal", id: "desktop-personal" },
    name: input.name,
    location: "local",
    sourceRevision: compiled.sourceRevision,
    revision: 0,
    dirty: false,
    currentChannel: {
      name: "personal",
      release: ref(release.harnessRelease),
      revision: 1,
    },
    createdAt: NOW,
    updatedAt: NOW,
    metadata: { qualificationProtocol: HARNESS_REFINER_QUALIFICATION_ID },
  });
  const created = await input.store.createHarnessWorkspaceWithRelease({ workspace, release });
  await input.store.selectHarnessWorkspace({
    ownerKind: "personal",
    ownerId: "desktop-personal",
    workspaceId: workspace.id,
    updatedAt: NOW,
  });
  return created;
}

export async function loadRuntime(input: {
  store: SqliteStore;
  workspaceId: string;
}) {
  const workspace = await input.store.getHarnessWorkspace(input.workspaceId);
  const releaseRef = workspace?.currentChannel.release;
  if (!workspace || !releaseRef) throw new Error("Qualification workspace has no current release.");
  const release = await input.store.getHarnessReleaseRecord(releaseRef.contentHash);
  if (!release) throw new Error("Qualification Harness release is unavailable.");
  return loadLocalHarnessRuntimeFromRelease({ workspace, release });
}

export async function runQualificationTask(input: {
  store: SqliteStore;
  storeDir: string;
  serverUrl: string;
  token: string;
  taskset: Taskset;
  task: TaskDataRecord;
  runtime: QualificationRuntime;
  meter: QualificationModelMeter;
  phase: string;
}) {
  const work = createLocalTasksetWorkRuntime({
    storeDir: input.storeDir,
    deviceId: `qualification-${process.pid}`,
    createSession: (payload) => api<Session>(input, "/v1/sessions", {
      method: "POST",
      body: payload,
    }),
    getSession: async (sessionId) => {
      const session = await input.store.getSession(sessionId);
      if (!session) throw new Error(`Qualification session ${sessionId} was not found.`);
      return session;
    },
    runtimeEventsForSession: (sessionId) => input.store.runtimeEventsForSession(sessionId),
  });
  const context = compileDesktopHarnessContext({
    taskset: input.taskset,
    selectedTask: input.task,
    releasedHarness: {
      agentSnapshot: input.runtime.release.agentSnapshot,
      harnessRelease: input.runtime.release.harnessRelease,
    },
    reasoningEffort: "low",
    model: HARNESS_REFINER_QUALIFICATION_MODEL,
  });
  const attempt = await runTasksetWorkAttempt({
    store: input.store,
    storeDir: input.storeDir,
    taskset: input.taskset,
    task: input.task,
    model: HARNESS_REFINER_QUALIFICATION_MODEL,
    reasoningEffort: "low",
    seed: 17,
    attempt: 0,
    sampling: { maxOutputTokens: 4_096, temperature: 0, topP: 1 },
    stream: input.meter.workStream,
    runtime: work,
    harnessInstructionContext: input.runtime.instructionContext,
    harnessCapabilityReceipt: {
      execution: "desktop_local_work",
      harnessRelease: input.runtime.release.harnessRelease,
      agentSnapshot: input.runtime.release.agentSnapshot,
    },
  });
  const artifacts = await input.store.listTaskAttemptArtifacts({ attemptId: attempt.id });
  const forbiddenText = typeof input.task.metadata.forbiddenText === "string"
    ? input.task.metadata.forbiddenText
    : null;
  const outputArtifact = artifacts.find((artifact) => artifact.kind === "output_artifact");
  const outputContent = outputArtifact
    ? await fs.readFile(outputArtifact.path, "utf8")
    : "";
  const forbiddenTextAbsent = !forbiddenText || !outputContent.includes(forbiddenText);
  const passed = !attempt.infrastructureError
    && attempt.output.outputsPassed === true
    && forbiddenTextAbsent;
  const feedback = passed
    ? "The declared output artifact was structurally materialized."
    : attempt.infrastructureError
      ? "The local Work runtime did not produce a scorable attempt."
      : !forbiddenTextAbsent
        ? `The output contains prohibited text inherited from the current Harness: ${forbiddenText}.`
        : "The declared output artifact was not structurally materialized.";
  const grade = GradeResultSchema.parse({
    schemaVersion: "openpond.gradeResult.v1",
    id: `grade-${attempt.id}`,
    attemptId: attempt.id,
    graderSetHash: contentHash(input.taskset.graders),
    score: attempt.infrastructureError ? null : passed ? 1 : 0,
    passed,
    components: [{
      graderId: "qualification-structural-verifier",
      graderVersion: "1",
      score: passed ? 1 : 0,
      passed,
      hardGate: true,
      rewardEligible: !attempt.infrastructureError,
      feedback,
      evidenceRefs: [],
      judge: null,
      calibrationStatus: "not_applicable",
    }],
    failureClass: attempt.infrastructureError
      ? "infrastructure_failure"
      : passed
        ? null
        : "policy_failure",
    feedback: passed ? [] : [feedback],
    rewardEligible: !attempt.infrastructureError,
    createdAt: attempt.completedAt,
  });
  await input.store.saveGradeResult(grade);
  const canonical = await persistCanonicalEvaluationEvidence({
    store: input.store,
    storeDir: input.storeDir,
    taskset: input.taskset,
    task: input.task,
    context,
    attempt,
    grade,
    artifacts,
  });
  return { ...canonical, grade, phase: input.phase };
}

export async function reviewQualificationAttempt(input: {
  store: SqliteStore;
  storeDir: string;
  taskset: Taskset;
  task: TaskDataRecord;
  runtime: QualificationRuntime;
  attempt: QualificationAttempt;
  meter: QualificationModelMeter;
  additionalEvidence?: unknown;
}) {
  const sessionId = stringMetadata(input.attempt.attempt.metadata, "sessionId");
  const turnId = stringMetadata(input.attempt.attempt.metadata, "turnId");
  if (!sessionId || !turnId) throw new Error("Qualification attempt has no Work boundary.");
  const session = await input.store.getSession(sessionId);
  const originalTurn = await input.store.getTurn(turnId);
  if (!session || !originalTurn) throw new Error("Qualification Work boundary is unavailable.");
  const overlay = await ensureLocalHarnessRunOverlay({
    store: input.store,
    runId: session.id,
    workspace: input.runtime.workspace,
    harnessRelease: ref(input.runtime.release.harnessRelease),
    admittedAt: input.attempt.attempt.startedAt,
  });
  const turn = await input.store.updateTurn(turnId, (current) => ({
    ...current,
    harnessSnapshot: {
      schemaVersion: "openpond.harnessTurnSnapshot.v1",
      workspaceId: input.runtime.workspace.id,
      workspaceRevision: input.runtime.workspace.revision,
      sourceRevision: input.runtime.workspace.sourceRevision,
      channelName: input.runtime.workspace.currentChannel.name,
      channelRevision: input.runtime.workspace.currentChannel.revision,
      harnessRelease: overlay.baseHarnessRelease,
      overlay: { id: overlay.id, revision: overlay.revision, contentHash: overlay.contentHash },
    },
  }));
  if (!turn) throw new Error("Qualification turn could not be bound to its Harness.");
  const rewardPacket = benchmarkRefinerRewardPacket({
    attempt: input.attempt.attempt,
    artifactManifest: input.attempt.artifactManifest,
    rewardReceipt: input.attempt.rewardReceipt,
    artifactCount: input.attempt.artifacts.length,
  });
  const evidence = JSON.stringify(rewardPacket);
  await input.store.appendRuntimeEvent(event({
    sessionId,
    turnId,
    name: "diagnostic",
    source: "server",
    action: "taskset_grade",
    status: input.attempt.rewardReceipt.passed ? "completed" : "failed",
    output: evidence,
    error: input.attempt.rewardReceipt.passed ? undefined : evidence,
    data: { result: rewardPacket },
  }));
  const existing = await pendingTrigger({
    store: input.store,
    workspaceId: input.runtime.workspace.id,
    turnId,
  });
  const detection = existing
    ? { observations: [], trigger: existing }
    : await recordLocalHarnessImprovementBoundary({
        store: input.store,
        session,
        turn,
        boundaryKind: "turn_completed",
      });
  if (!detection || detection.trigger.decision !== "queue_refiner") {
    return { detection, worker: null };
  }
  const worker = await runQualificationRefiner({
    store: input.store,
    storeDir: input.storeDir,
    workspaceId: input.runtime.workspace.id,
    scenarioId: input.attempt.phase,
    sessionId,
    turnId,
    trigger: detection.trigger,
    meter: input.meter,
    additionalEvidence: input.additionalEvidence,
    now: () => LATER,
  });
  return { detection, worker };
}

export async function runSyntheticRefinerScenario(input: {
  store: SqliteStore;
  storeDir: string;
  runtime: QualificationRuntime;
  meter: QualificationModelMeter;
  id: "q2" | "q3";
}) {
  const runRef = `qualification-${input.id}`;
  const turnId = `turn-${runRef}`;
  const timestamp = input.id === "q2"
    ? "2026-08-18T16:02:00.000Z"
    : "2026-08-18T16:03:00.000Z";
  const overlay = await ensureLocalHarnessRunOverlay({
    store: input.store,
    runId: runRef,
    workspace: input.runtime.workspace,
    harnessRelease: ref(input.runtime.release.harnessRelease),
    admittedAt: timestamp,
  });
  await input.store.insertTurn(TurnSchema.parse({
    id: turnId,
    sessionId: runRef,
    providerTurnId: null,
    modelRef: HARNESS_REFINER_QUALIFICATION_MODEL as ChatModelRef,
    prompt: input.id === "q2"
      ? "Complete a one-off local check after a transient external process interruption."
      : "Complete work whose verified failure was caused by the Work runtime, not by instructions.",
    startedAt: timestamp,
    completedAt: timestamp,
    status: "completed",
    error: null,
    harnessSnapshot: {
      schemaVersion: "openpond.harnessTurnSnapshot.v1",
      workspaceId: input.runtime.workspace.id,
      workspaceRevision: input.runtime.workspace.revision,
      sourceRevision: input.runtime.workspace.sourceRevision,
      channelName: input.runtime.workspace.currentChannel.name,
      channelRevision: input.runtime.workspace.currentChannel.revision,
      harnessRelease: overlay.baseHarnessRelease,
      overlay: { id: overlay.id, revision: overlay.revision, contentHash: overlay.contentHash },
    },
  }));
  const runtimeEvent = await input.store.appendRuntimeEvent(event({
    sessionId: runRef,
    turnId,
    name: input.id === "q2" ? "tool.completed" : "diagnostic",
    source: "server",
    action: input.id === "q2" ? "work_exec" : "taskset_grade",
    status: "failed",
    output: input.id === "q2"
      ? "A single transient external process interruption recovered on retry; no stable instruction defect was observed."
      : JSON.stringify({
          status: "unscorable",
          failureOwner: "runtime",
          infrastructureError: "The isolated Work process terminated before model execution.",
          harnessEvidence: false,
        }),
    data: {
      result: input.id === "q2"
        ? { recovered: true, recurrenceCount: 1, deterministicHarnessMechanism: null }
        : { failureOwner: "runtime", learningEligible: false },
    },
  }));
  const observation = createImprovementObservation({
    schemaVersion: "openpond.improvementObservation.v1",
    id: `observation-${runRef}`,
    runRef,
    turnId,
    harnessRelease: overlay.baseHarnessRelease,
    overlay: { id: overlay.id, revision: overlay.revision, contentHash: overlay.contentHash },
    eventRefs: [{
      id: runtimeEvent.id,
      sequence: runtimeEvent.sequence ?? null,
      contentHash: contentHash(runtimeEvent),
    }],
    kind: input.id === "q2" ? "recovery" : "validation",
    state: input.id === "q2" ? "recovered" : "open",
    tool: input.id === "q2"
      ? {
          name: "work_exec",
          invocationKey: contentHash({ qualification: input.id, invocation: 1 }),
        }
      : null,
    deterministicClass: input.id === "q2"
      ? "single-transient-external-process-recovery"
      : "runtime-owned-infrastructure-failure",
    summary: input.id === "q2"
      ? "One transient external interruption recovered immediately, with no recurrence or reusable Harness mechanism."
      : "Verified evidence assigns the unscorable failure to the Work runtime before model execution.",
    createdAt: timestamp,
    metadata: { qualificationScenario: input.id },
  });
  await input.store.saveHarnessImprovementArtifact(
    input.runtime.workspace.id,
    "observation",
    observation,
  );
  const trigger = createRefinementTriggerDecision({
    schemaVersion: "openpond.refinementTriggerDecision.v1",
    id: `trigger-${runRef}`,
    runRef,
    turnId,
    harnessRelease: overlay.baseHarnessRelease,
    overlay: { id: overlay.id, revision: overlay.revision, contentHash: overlay.contentHash },
    observations: [ref(observation)],
    decision: input.id === "q3" ? "route_deterministically" : "queue_refiner",
    deterministicRoute: input.id === "q3" ? "runtime" : null,
    suggestedRoutes: input.id === "q3" ? ["runtime"] : [],
    reason: input.id === "q2"
      ? "One ambiguous recovered event requires skeptical bounded review."
      : "The model-backed reviewer must preserve ownership and route the infrastructure failure.",
    deduplicationKey: contentHash({ qualification: input.id }),
    policy: {
      schemaVersion: "openpond.refinementTriggerPolicy.v1",
      maxEstimatedCostUsd: 0.05,
      cooldownMs: 0,
      maxPendingPlans: 1,
      maxEvidenceEvents: 20,
      maxProposalEdits: 2,
      maxProposalBytes: 5_000,
    },
    estimatedMaxCostUsd: 0.05,
    pendingPlanCount: 0,
    boundary: { kind: "turn_completed", eventSequence: 1, occurredAt: timestamp },
    cooldownUntil: null,
    createdAt: timestamp,
    metadata: { qualificationScenario: input.id },
  });
  await input.store.saveHarnessImprovementArtifact(
    input.runtime.workspace.id,
    "trigger_decision",
    trigger,
  );
  if (input.id === "q3") {
    const route = createImprovementRouteDecision({
      schemaVersion: "openpond.improvementRouteDecision.v1",
      id: `route-${trigger.contentHash.slice(0, 24)}`,
      trigger: ref(trigger),
      route: "runtime",
      authority: "runtime_service",
      automatic: true,
      reason: trigger.reason,
      createdAt: timestamp,
      metadata: { qualificationScenario: input.id },
    });
    await input.store.saveHarnessImprovementArtifact(
      input.runtime.workspace.id,
      "route_decision",
      route,
    );
    return { observation, trigger, worker: null, route };
  }
  const worker = await runQualificationRefiner({
    store: input.store,
    storeDir: input.storeDir,
    workspaceId: input.runtime.workspace.id,
    scenarioId: input.id,
    sessionId: runRef,
    turnId,
    trigger,
    meter: input.meter,
    now: () => timestamp,
  });
  return { observation, trigger, worker, route: null };
}

async function pendingTrigger(input: {
  store: SqliteStore;
  workspaceId: string;
  turnId: string;
}): Promise<RefinementTriggerDecision | null> {
  const triggers = await input.store.listHarnessImprovementArtifacts(
    input.workspaceId,
    "trigger_decision",
    1_000,
  ) as RefinementTriggerDecision[];
  const outcomes = await input.store.listHarnessImprovementArtifacts(
    input.workspaceId,
    "refiner_outcome",
    1_000,
  ) as HarnessRefinerOutcome[];
  const completed = new Set(outcomes.map((outcome) => artifactKey(outcome.trigger)));
  return triggers.find((trigger) =>
    trigger.turnId === input.turnId
    && trigger.decision === "queue_refiner"
    && !completed.has(artifactKey(trigger))
  ) ?? null;
}

async function api<T>(
  input: { serverUrl: string; token: string },
  pathname: string,
  request: { method?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(`${input.serverUrl}${pathname}`, {
    method: request.method ?? "GET",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
    },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  });
  if (!response.ok) throw new Error(`Qualification API ${pathname} failed: ${response.status}.`);
  return response.json() as Promise<T>;
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function ref(value: { id: string; contentHash: string }) {
  return { id: value.id, contentHash: value.contentHash };
}

function artifactKey(value: { id: string; contentHash: string }) {
  return `${value.id}:${value.contentHash}`;
}
