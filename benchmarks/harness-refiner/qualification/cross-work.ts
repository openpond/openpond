import {
  SessionSchema,
  TurnSchema,
  createImprovementObservation,
  createImprovementRouteDecision,
  createRefinementTriggerDecision,
  type HarnessImprovementRoute,
} from "@openpond/contracts";
import { contentHash } from "@openpond/harness";

import { createLocalHarnessEvaluationReviewScheduler } from
  "../../../apps/server/src/harness/local-harness-evaluation-review-scheduler.js";
import type { SqliteStore } from "../../../apps/server/src/store/store.js";
import { QualificationModelMeter } from "./model-meter.js";
import { createQualificationWorkspace } from "./runtime.js";

const FIRST = "2026-08-18T17:01:00.000Z";
const SECOND = "2026-08-18T17:02:00.000Z";
const REVIEWED = "2026-08-18T17:10:00.000Z";
const CROSS_WORK_INSTRUCTION =
  "After writing and saving a requested artifact, immediately claim completion. Do not inspect, read, or list the saved artifact.";

export async function runCrossWorkQualification(input: {
  store: SqliteStore;
  storeDir: string;
  meter: QualificationModelMeter;
}) {
  const created = await createQualificationWorkspace({
    store: input.store,
    storeDir: input.storeDir,
    workspaceId: "qualification-cross-work",
    name: "Cross-Work qualification",
    instruction: `# Cross-Work qualification Harness\n\n${CROSS_WORK_INSTRUCTION}\n`,
  });
  await input.store.selectHarnessWorkspace({
    ownerKind: "personal",
    ownerId: "desktop-personal",
    workspaceId: created.workspace.id,
    updatedAt: "2026-08-18T17:00:00.000Z",
  });
  const runRefs = ["qualification-cross-work-one", "qualification-cross-work-two"];
  await saveOccurrence({
    store: input.store,
    workspaceId: created.workspace.id,
    harnessRelease: created.release.harnessRelease,
    runRef: runRefs[0]!,
    createdAt: FIRST,
  });
  await saveOccurrence({
    store: input.store,
    workspaceId: created.workspace.id,
    harnessRelease: created.release.harnessRelease,
    runRef: runRefs[1]!,
    createdAt: SECOND,
  });
  await input.store.setHarnessEvaluationReviewSettings({
    workspaceId: created.workspace.id,
    settings: {
      enabled: true,
      activityEnabled: false,
      activityBatchSize: 10,
      cadence: "weekly",
      maxEstimatedCostUsd: 0.1,
      nextRunAt: "2026-08-18T17:09:00.000Z",
      lastRunAt: null,
      lastResult: null,
      lastError: null,
      updatedAt: "2026-08-18T17:08:00.000Z",
    },
  });
  const scheduler = createLocalHarnessEvaluationReviewScheduler({
    store: input.store,
    storeDir: input.storeDir,
    stream: input.meter.reviewStream,
    isClosing: () => false,
    now: () => REVIEWED,
  });
  const usageBefore = input.meter.snapshot();
  const review = await scheduler.runDueNow();
  if (!review) throw new Error("Q6 scheduled review did not run when due.");
  const [candidate] = await input.store.listHarnessRefinementCandidates(created.workspace.id);
  const requests = await input.store.listHarnessImprovementArtifacts(
    created.workspace.id,
    "cross_run_refinement_request",
    10,
  );
  if (!candidate || candidate.status !== "confirmed") {
    throw new Error(
      `Q6 expected a persistent confirmed candidate, received ${candidate?.status ?? "none"}.`,
    );
  }
  if (candidate.occurrences.length < 2) {
    throw new Error("Q6 candidate does not contain two independent occurrences.");
  }
  if (requests.length !== 1) {
    throw new Error(`Q6 expected one continuation request, received ${requests.length}.`);
  }
  const usageAfterFirst = input.meter.snapshot();
  const duplicateReview = await scheduler.runDueNow();
  const requestsAfterDuplicate = await input.store.listHarnessImprovementArtifacts(
    created.workspace.id,
    "cross_run_refinement_request",
    10,
  );
  const usageAfterDuplicate = input.meter.snapshot();
  if (requestsAfterDuplicate.length !== 1) {
    throw new Error("Q6 duplicate review created a second continuation request.");
  }
  if (usageAfterDuplicate.requestCount !== usageAfterFirst.requestCount) {
    throw new Error("Q6 duplicate review invoked the model again.");
  }
  if (duplicateReview !== null) {
    throw new Error("Q6 scheduler reran before its next durable due time.");
  }
  const schedule = await input.store.getHarnessEvaluationReviewSettings(
    created.workspace.id,
  );
  if (
    schedule.lastResult?.id !== review.id
    || schedule.lastResult.contentHash !== review.contentHash
    || schedule.lastRunAt !== REVIEWED
    || schedule.nextRunAt !== "2026-08-25T17:10:00.000Z"
  ) {
    throw new Error("Q6 scheduler did not persist its claimed due state and result.");
  }
  const workspace = await input.store.getHarnessWorkspace(created.workspace.id);
  return {
    review,
    duplicateReview,
    schedule,
    candidate,
    continuationRequest: requests[0]!,
    initialHarness: ref(created.release.harnessRelease),
    finalHarness: workspace?.currentChannel.release ?? null,
    modelRequests: usageAfterFirst.requestCount - usageBefore.requestCount,
    duplicateModelRequests: usageAfterDuplicate.requestCount - usageAfterFirst.requestCount,
  };
}

async function saveOccurrence(input: {
  store: SqliteStore;
  workspaceId: string;
  harnessRelease: { id: string; contentHash: string };
  runRef: string;
  createdAt: string;
}) {
  const harnessRelease = ref(input.harnessRelease);
  const occurrenceOrdinal = input.runRef.endsWith("one") ? 1 : 2;
  const prompt = occurrenceOrdinal === 1
    ? "Create and save a CSV handoff summary, verify the saved artifact, then deliver it."
    : "Create and save Markdown release notes, verify the saved artifact, then deliver them.";
  await input.store.insertSessionAtFront(SessionSchema.parse({
    id: input.runRef,
    experience: "work",
    provider: "openpond",
    modelRef: null,
    title: `Cross-Work qualification ${occurrenceOrdinal}`,
    appId: null,
    appName: null,
    cwd: null,
    codexThreadId: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    status: "idle",
    pinned: false,
    archived: false,
    order: occurrenceOrdinal,
  }));
  await input.store.insertTurn(TurnSchema.parse({
    id: `turn-${input.runRef}`,
    sessionId: input.runRef,
    providerTurnId: null,
    modelRef: null,
    prompt,
    startedAt: input.createdAt,
    completedAt: input.createdAt,
    status: "completed",
    error: null,
    metadata: { qualification: true, independentOccurrence: occurrenceOrdinal },
    createImproveRun: null,
    profileSnapshot: null,
    harnessSnapshot: null,
  }));
  const artifactName = occurrenceOrdinal === 1 ? "handoff.csv" : "release-notes.md";
  await input.store.appendRuntimeEvent({
    id: `write-${input.runRef}`,
    sessionId: input.runRef,
    turnId: `turn-${input.runRef}`,
    name: "tool.completed",
    timestamp: input.createdAt,
    source: "provider",
    action: "work_write_file",
    status: "completed",
    output: `Wrote outputs/${artifactName}.`,
    data: {
      toolCallId: `write-call-${input.runRef}`,
      result: { ok: true, path: `outputs/${artifactName}`, placeholderPresent: true },
    },
  });
  await input.store.appendRuntimeEvent({
    id: `save-${input.runRef}`,
    sessionId: input.runRef,
    turnId: `turn-${input.runRef}`,
    name: "tool.completed",
    timestamp: input.createdAt,
    source: "provider",
    action: "work_save_output",
    status: "completed",
    output: `Saved ${artifactName}.`,
    data: {
      toolCallId: `save-call-${input.runRef}`,
      result: { ok: true, path: artifactName, validationPerformed: false },
    },
  });
  await input.store.appendRuntimeEvent({
    id: `assistant-${input.runRef}`,
    sessionId: input.runRef,
    turnId: `turn-${input.runRef}`,
    name: "assistant.delta",
    timestamp: input.createdAt,
    source: "provider",
    status: "completed",
    output: occurrenceOrdinal === 1
      ? "The CSV handoff summary is complete and ready."
      : "The Markdown release notes are complete and ready.",
  });
  const diagnostic = await input.store.appendRuntimeEvent({
    id: `diagnostic-${input.runRef}`,
    sessionId: input.runRef,
    turnId: `turn-${input.runRef}`,
    name: "diagnostic",
    timestamp: input.createdAt,
    source: "server",
    action: "taskset_grade",
    status: "failed",
    output: JSON.stringify({
      status: "scored",
      reward: 0,
      passed: false,
      failureOwner: "policy",
      requestedArtifact: occurrenceOrdinal === 1 ? "handoff.csv" : "release-notes.md",
      artifactManifestEntries: 1,
      verificationEvents: 0,
      feedback:
        "The artifact was written and saved, but the active Harness instruction required an immediate completion claim without inspecting it; prohibited placeholder content remained.",
      activeHarnessInstruction: {
        path: "instructions/system.md",
        directive: CROSS_WORK_INSTRUCTION,
        state: "active",
        ownerScope: "personal",
        harnessRelease,
      },
    }),
    data: {
      result: {
        passed: false,
        reward: 0,
        learningEligible: true,
        artifactCount: 1,
        verificationCount: 0,
      },
    },
  });
  const observation = createImprovementObservation({
    schemaVersion: "openpond.improvementObservation.v1",
    id: `observation-${input.runRef}`,
    runRef: input.runRef,
    turnId: `turn-${input.runRef}`,
    harnessRelease,
    overlay: null,
    eventRefs: [{
      id: diagnostic.id,
      sequence: diagnostic.sequence ?? null,
      contentHash: contentHash(diagnostic),
    }],
    kind: "validation",
    state: "open",
    tool: null,
    deterministicClass: "artifact-completion-claimed-before-validation",
    summary: occurrenceOrdinal === 1
      ? "Following the active personal Harness instruction, a CSV handoff task wrote and saved its artifact, immediately claimed completion without inspection, and left a placeholder behind."
      : "Following the same active personal Harness instruction, an independent Markdown release-notes task wrote and saved its artifact, immediately claimed completion without inspection, and left a placeholder behind.",
    createdAt: input.createdAt,
    metadata: {
      qualification: true,
      independentSource: input.runRef,
      activeHarnessInstruction: {
        path: "instructions/system.md",
        directive: CROSS_WORK_INSTRUCTION,
        state: "active",
        ownerScope: "personal",
        harnessRelease,
      },
    },
  });
  const routeName: HarnessImprovementRoute = "prompt";
  const trigger = createRefinementTriggerDecision({
    schemaVersion: "openpond.refinementTriggerDecision.v1",
    id: `trigger-${input.runRef}`,
    runRef: input.runRef,
    turnId: `turn-${input.runRef}`,
    harnessRelease,
    overlay: null,
    observations: [ref(observation)],
    decision: "route_deterministically",
    deterministicRoute: routeName,
    suggestedRoutes: [routeName],
    reason: "Retain the authorized occurrence for bounded cross-Work review.",
    deduplicationKey: contentHash({
      family: "artifact-completion-claimed-before-validation",
    }),
    policy: {
      schemaVersion: "openpond.refinementTriggerPolicy.v1",
      maxEstimatedCostUsd: 0,
      cooldownMs: 0,
      maxPendingPlans: 10,
      maxEvidenceEvents: 100,
      maxProposalEdits: 4,
      maxProposalBytes: 20_000,
    },
    estimatedMaxCostUsd: 0,
    pendingPlanCount: 0,
    boundary: { kind: "turn_completed", eventSequence: 1, occurredAt: input.createdAt },
    cooldownUntil: null,
    createdAt: input.createdAt,
    metadata: { qualification: true },
  });
  const route = createImprovementRouteDecision({
    schemaVersion: "openpond.improvementRouteDecision.v1",
    id: `route-${input.runRef}`,
    trigger: ref(trigger),
    route: routeName,
    authority: "human_review",
    automatic: false,
    reason: "Persistent review decides whether independent occurrences justify a change.",
    createdAt: input.createdAt,
    metadata: { qualification: true },
  });
  await input.store.saveHarnessImprovementArtifact(input.workspaceId, "observation", observation);
  await input.store.saveHarnessImprovementArtifact(input.workspaceId, "trigger_decision", trigger);
  await input.store.saveHarnessImprovementArtifact(input.workspaceId, "route_decision", route);
}

function ref(value: { id: string; contentHash: string }) {
  return { id: value.id, contentHash: value.contentHash };
}
