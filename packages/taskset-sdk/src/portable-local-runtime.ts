import {
  HarnessGraderEvidenceSchema,
  HarnessRunTraceSchema,
  LearningSignalEnvelopeSchema,
  ModelActionSchema,
  ToolObservationSchema,
  type HarnessGraderEvidence,
  type HarnessRunManifest,
  type HarnessRunTrace,
  type LearningSignalEnvelope,
  type LearningSignalLineage,
  type ModelAction,
  type ToolObservation,
} from "@openpond/contracts";

import { contentHash } from "./hashing.js";

export type PortableHarnessTask = {
  id: string;
  input: Record<string, unknown>;
};

export type PortableHarnessLease = {
  id: string;
  metadata: Record<string, unknown>;
};

export interface PortableLocalHarnessRuntime {
  create(input: {
    manifest: HarnessRunManifest;
    task: PortableHarnessTask;
    seed: string;
  }): Promise<PortableHarnessLease>;
  reset(lease: PortableHarnessLease, seed: string): Promise<void>;
  step(
    lease: PortableHarnessLease,
    action: ModelAction,
  ): Promise<ToolObservation>;
  grade(lease: PortableHarnessLease): Promise<HarnessGraderEvidence[]>;
  collect(lease: PortableHarnessLease): Promise<{
    artifactRefs: string[];
    metadata: Record<string, unknown>;
  }>;
  destroy(lease: PortableHarnessLease): Promise<void>;
}

export async function runPortableHarnessLocally(input: {
  manifest: HarnessRunManifest;
  task: PortableHarnessTask;
  seed: string;
  actions: ModelAction[];
  runtime: PortableLocalHarnessRuntime;
  lineage: LearningSignalLineage;
  now?: () => string;
}): Promise<{
  trace: HarnessRunTrace;
  artifactRefs: string[];
  replayHash: string;
}> {
  const now = input.now ?? (() => new Date().toISOString());
  const actions = input.actions.map((action) => {
    const parsed = ModelActionSchema.parse(action);
    assertCanonicalHash("model action", parsed);
    return parsed;
  });
  const observations: ToolObservation[] = [];
  let graderEvidence: HarnessGraderEvidence[] = [];
  let artifactRefs: string[] = [];
  let lease: PortableHarnessLease | null = null;
  let failureClass: HarnessRunTrace["failureClass"] = null;
  let terminal = false;
  let sequence = 0;
  const events: HarnessRunTrace["events"] = [];
  const event = (
    type: HarnessRunTrace["events"][number]["type"],
    payload: unknown,
    metadata: Record<string, unknown> = {},
  ) => {
    events.push({
      sequence: sequence++,
      type,
      timestamp: now(),
      payloadHash: contentHash(payload),
      metadata,
    });
  };

  try {
    lease = await input.runtime.create({
      manifest: input.manifest,
      task: input.task,
      seed: input.seed,
    });
    event("created", { leaseId: lease.id });
    await input.runtime.reset(lease, input.seed);
    event("reset", { seed: input.seed });
    for (const action of actions) {
      event("action", action);
      const observation = ToolObservationSchema.parse(
        await input.runtime.step(lease, action),
      );
      assertCanonicalHash("tool observation", observation);
      if (observation.actionId !== action.id || observation.turn !== action.turn) {
        throw new Error(
          `Observation for ${observation.actionId} does not match action ${action.id}.`,
        );
      }
      observations.push(observation);
      event("observation", observation);
      if (observation.terminal) {
        terminal = true;
        event("terminal", observation);
        break;
      }
    }
    graderEvidence = (await input.runtime.grade(lease)).map((item) => {
      const parsed = HarnessGraderEvidenceSchema.parse(item);
      assertCanonicalHash("grader evidence", parsed);
      return parsed;
    });
    event("graded", graderEvidence);
    for (const evidence of graderEvidence) {
      for (const feedback of evidence.feedback) {
        event("feedback", feedback, { graderId: evidence.graderId });
      }
    }
    failureClass =
      graderEvidence.find((item) => item.failureClass)?.failureClass ?? null;
    terminal = terminal || graderEvidence.length > 0;
  } catch (error) {
    failureClass = "infrastructure_failure";
    event(
      "failure",
      {
        code: "local_runtime_failure",
        message: error instanceof Error ? error.message : String(error),
      },
      { rewardEligible: false },
    );
  } finally {
    if (lease) {
      try {
        const collected = await input.runtime.collect(lease);
        artifactRefs = [...new Set(collected.artifactRefs)].sort();
        event("collected", collected);
      } catch (error) {
        failureClass = "infrastructure_failure";
        event(
          "failure",
          {
            code: "local_collect_failure",
            message: error instanceof Error ? error.message : String(error),
          },
          { rewardEligible: false },
        );
      }
      try {
        await input.runtime.destroy(lease);
        event("destroyed", { leaseId: lease.id });
      } catch (error) {
        failureClass = "infrastructure_failure";
        event(
          "failure",
          {
            code: "local_destroy_failure",
            message: error instanceof Error ? error.message : String(error),
          },
          { rewardEligible: false },
        );
      }
    }
  }

  const transcript = {
    manifest: input.manifest.contentHash,
    taskId: input.task.id,
    seed: input.seed,
    events: events.map(({ type, payloadHash, metadata }) => ({
      type,
      payloadHash,
      metadata,
    })),
    actions,
    observations,
    graderEvidence,
    terminal,
    failureClass,
    artifactRefs,
  };
  const artifactHash = contentHash(transcript);
  const learningSignals = createLearningSignals({
    taskId: input.task.id,
    manifest: input.manifest,
    lineage: input.lineage,
    graderEvidence,
    failureClass,
    traceHash: artifactHash,
    now,
  });
  const base = {
    schemaVersion: "openpond.harnessRunTrace.v1" as const,
    manifest: {
      id: input.manifest.id,
      contentHash: input.manifest.contentHash,
    },
    taskId: input.task.id,
    seed: input.seed,
    events,
    actions,
    observations,
    graderEvidence,
    learningSignals,
    terminal,
    failureClass,
    artifactHash,
  };
  const trace = HarnessRunTraceSchema.parse({
    ...base,
    contentHash: contentHash(base),
  });
  return { trace, artifactRefs, replayHash: portableTraceReplayHash(trace) };
}

export function portableTraceReplayHash(trace: HarnessRunTrace): string {
  return contentHash({
    manifest: trace.manifest,
    taskId: trace.taskId,
    seed: trace.seed,
    events: trace.events.map(({ type, payloadHash, metadata }) => ({
      type,
      payloadHash,
      metadata,
    })),
    actions: trace.actions,
    observations: trace.observations,
    graderEvidence: trace.graderEvidence,
    learningSignals: trace.learningSignals.map(
      ({ createdAt: _createdAt, contentHash: _signalHash, ...signal }) => signal,
    ),
    terminal: trace.terminal,
    failureClass: trace.failureClass,
    artifactHash: trace.artifactHash,
  });
}

export function assertPortableReplay(
  expected: HarnessRunTrace,
  replayed: HarnessRunTrace,
): void {
  const expectedHash = portableTraceReplayHash(expected);
  const replayedHash = portableTraceReplayHash(replayed);
  if (expectedHash !== replayedHash) {
    throw new Error(
      `Portable harness replay diverged: expected ${expectedHash}, received ${replayedHash}.`,
    );
  }
}

function createLearningSignals(input: {
  taskId: string;
  manifest: HarnessRunManifest;
  lineage: LearningSignalLineage;
  graderEvidence: HarnessGraderEvidence[];
  failureClass: HarnessRunTrace["failureClass"];
  traceHash: string;
  now: () => string;
}): LearningSignalEnvelope[] {
  if (input.failureClass === "infrastructure_failure") {
    return [
      signal({
        schemaVersion: "openpond.learningSignal.v1",
        id: `signal-${input.traceHash.slice(0, 24)}-failure`,
        taskId: input.taskId,
        episodeId: input.manifest.id,
        policyVersion: null,
        lineage: input.lineage,
        approved: false,
        verifier: "none",
        createdAt: input.now(),
        metadata: {},
        kind: "infrastructure_failure",
        payload: {
          code: "local_runtime_failure",
          phase: "harness_lifecycle",
          retryable: true,
          rewardEligible: false,
        },
      }),
    ];
  }
  const signals: LearningSignalEnvelope[] = [
    signal({
      schemaVersion: "openpond.learningSignal.v1",
      id: `signal-${input.traceHash.slice(0, 24)}-trajectory`,
      taskId: input.taskId,
      episodeId: input.manifest.id,
      policyVersion: null,
      lineage: input.lineage,
      approved: true,
      verifier: "deterministic",
      createdAt: input.now(),
      metadata: {},
      kind: "trajectory",
      payload: {
        traceRef: `sha256:${input.traceHash}`,
        traceHash: input.traceHash,
        terminal: true,
        failureClass: input.failureClass,
      },
    }),
  ];
  const eligible = input.graderEvidence.filter(
    (item) => item.rewardEligible && item.score !== null,
  );
  if (eligible.length > 0) {
    const components = Object.fromEntries(
      eligible.map((item) => [item.graderId, item.score!]),
    );
    signals.push(
      signal({
        schemaVersion: "openpond.learningSignal.v1",
        id: `signal-${input.traceHash.slice(0, 24)}-reward`,
        taskId: input.taskId,
        episodeId: input.manifest.id,
        policyVersion: null,
        lineage: input.lineage,
        approved: true,
        verifier: "deterministic",
        createdAt: input.now(),
        metadata: {},
        kind: "reward",
        payload: {
          reward:
            Object.values(components).reduce((total, value) => total + value, 0) /
            eligible.length,
          components,
          eligible: true,
          graderEvidenceRefs: eligible.map((item) => item.graderId),
        },
      }),
    );
  }
  for (const evidence of input.graderEvidence) {
    signals.push(
      signal({
        schemaVersion: "openpond.learningSignal.v1",
        id: `signal-${input.traceHash.slice(0, 16)}-${evidence.contentHash.slice(0, 16)}`,
        taskId: input.taskId,
        episodeId: input.manifest.id,
        policyVersion: null,
        lineage: input.lineage,
        approved: evidence.rewardEligible,
        verifier: "deterministic",
        createdAt: input.now(),
        metadata: {},
        kind: "grader_evidence",
        payload: {
          graderId: evidence.graderId,
          score: evidence.score,
          passed: evidence.passed,
          privilegedArtifactRefs: evidence.privilegedEvidenceRefs,
        },
      }),
    );
    for (const [turnIndex, feedback] of evidence.feedback.entries()) {
      signals.push(
        signal({
          schemaVersion: "openpond.learningSignal.v1",
          id: `signal-${input.traceHash.slice(0, 12)}-${evidence.contentHash.slice(0, 12)}-${turnIndex}`,
          taskId: input.taskId,
          episodeId: input.manifest.id,
          policyVersion: null,
          lineage: input.lineage,
          approved: evidence.rewardEligible,
          verifier: "deterministic",
          createdAt: input.now(),
          metadata: { graderId: evidence.graderId },
          kind: "targeted_feedback",
          payload: {
            turnIndex,
            target: "answer",
            feedback,
          },
        }),
      );
    }
  }
  return signals;
}

function signal(
  value: Omit<LearningSignalEnvelope, "contentHash">,
): LearningSignalEnvelope {
  return LearningSignalEnvelopeSchema.parse({
    ...value,
    contentHash: contentHash(value),
  });
}

function assertCanonicalHash(
  label: string,
  value: { contentHash: string },
): void {
  const { contentHash: actual, ...content } = value;
  const expected = contentHash(content);
  if (actual !== expected) {
    throw new Error(`${label} content hash mismatch.`);
  }
}
