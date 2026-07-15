import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CrossSystemFrontierBaselineRunSchema, TaskCreationSnapshotSchema, TaskMinerRunSchema } from "../packages/contracts/src";
import { TrainingAutomaticScopeStep } from "../apps/web/src/components/training/TrainingAutomaticScopeStep";
import { TrainingRunDialog } from "../apps/web/src/components/training/TrainingRunDialog";
import { shouldRevealMinerCandidates } from "../apps/web/src/components/training/training-flow";
import { TrainingRunReviewStep } from "../apps/web/src/components/training/TrainingRunReviewStep";
import { proposalFixture, sourceFixture } from "./helpers/training-fixtures";

describe("New model flow", () => {
  test("starts from user intent rather than asking for an optimizer", () => {
    const html = renderToStaticMarkup(<TrainingRunDialog {...dialogProps()} initialObjective={null} />);
    expect(html).toContain("How do you want to start?");
    expect(html).toContain("Automated");
    expect(html).toContain("Review repeated work in chats");
    expect(html).toContain("Manual");
    expect(html).toContain("Start from a capability");
    for (const title of ["Supervised fine-tuning", "Preference tuning", "Reinforcement learning"]) expect(html).not.toContain(title);
    expect(html).not.toContain('placeholder="Search chats"');
    expect(html).not.toContain('aria-label="Back');
  });

  test("pre-populated objectives still start at the explicit intent choice", () => {
    const html = renderToStaticMarkup(<TrainingRunDialog {...dialogProps()} initialObjective="Reconcile billing and support risk." initialSessionIds={["session_fixture"]} />);
    expect(html).toContain("Automated");
    expect(html).toContain("Manual");
    expect(html).not.toContain("Reconcile billing and support risk.");
    expect(html).not.toContain("Approved support workflow");
  });

  test("renders recommendation review, revision, and Add chats recovery when evidence is insufficient", () => {
    const source = sourceFixture();
    const creation = creationFixture("recommendation_ready", [source.id]);
    const html = renderToStaticMarkup(<TrainingRunReviewStep busy={false} creation={creation} onAddChats={() => undefined} onClose={() => undefined} onCreateTaskset={() => undefined} onCreationChange={() => undefined} sources={[source]} training={controller()} />);
    expect(html).toContain("What it should learn");
    expect(html).toContain("Review examples and evaluation");
    expect(html).toContain("Revise recommendation");
    expect(html).toContain(">Add chats</button>");
    expect(html).not.toContain(">Create Taskset</button>");
  });

  test("offers Taskset creation only after a trainable proposal has independent evaluation", () => {
    const train = sourceFixture();
    const evaluation = sourceFixture("source_eval", "cluster_eval");
    const creation = creationFixture("awaiting_materialization_approval", [train.id, evaluation.id]);
    const html = renderToStaticMarkup(<TrainingRunReviewStep busy={false} creation={creation} onAddChats={() => undefined} onClose={() => undefined} onCreateTaskset={() => undefined} onCreationChange={() => undefined} sources={[train, evaluation]} training={controller()} />);
    expect(html).toContain(">Create Taskset</button>");
    expect(html).not.toContain(">Add chats</button>");
  });

  test("keeps a primary GRPO recommendation separate from its optional SFT bootstrap", () => {
    const train = sourceFixture();
    const evaluation = sourceFixture("source_eval", "cluster_eval");
    const base = creationFixture("awaiting_materialization_approval", [train.id, evaluation.id]);
    const creation = TaskCreationSnapshotSchema.parse({
      ...base,
      proposal: {
        ...base.proposal,
        diagnosis: { ...base.proposal!.diagnosis, intervention: "grpo_rft" },
        proposedMethod: "grpo",
        trainingPath: { primaryMethod: "grpo", bootstrap: { method: "sft", purpose: "trajectory_bootstrap", demonstrationRefs: ["example_fixture_0"], limitations: ["SFT is not GRPO."] } },
      },
    });
    const html = renderToStaticMarkup(<TrainingRunReviewStep busy={false} creation={creation} onAddChats={() => undefined} onClose={() => undefined} onCreateTaskset={() => undefined} onCreationChange={() => undefined} sources={[train, evaluation]} training={controller()} />);
    expect(html).toContain("Model name");
    expect(html).toContain("Primary · GRPO");
    expect(html).toContain("Optional precursor · SFT trajectory bootstrap");
    expect(html).toContain("SFT is not GRPO.");
    expect(html).toContain("Not run yet");
  });

  test("keeps a non-training retrieval recommendation terminal instead of creating a model", () => {
    const source = sourceFixture();
    const proposal = proposalFixture([source.id]);
    const creation = TaskCreationSnapshotSchema.parse({
      ...creationFixture("recommendation_ready", [source.id]),
      proposal: {
        ...proposal,
        diagnosis: { ...proposal.diagnosis, stableBehavior: [], changingKnowledge: ["Current policy text."], intervention: "retrieval", trainingEligible: false },
        proposedExamples: [],
        proposedGraders: [],
        graderFixtures: [],
        generatedFiles: [],
        proposedMethod: "retrieval",
      },
    });
    const html = renderToStaticMarkup(<TrainingRunReviewStep busy={false} creation={creation} onAddChats={() => undefined} onClose={() => undefined} onCreateTaskset={() => undefined} onCreationChange={() => undefined} sources={[source]} training={controller()} />);
    expect(html).toContain("Retrieval");
    expect(html).toContain(">Done</button>");
    expect(html).not.toContain(">Add chats</button>");
    expect(html).not.toContain(">Create Taskset</button>");
  });

  test("renders durable frontier progress and a real cancellation action", () => {
    const html = renderToStaticMarkup(<TrainingAutomaticScopeStep
      chatCount={12}
      config={minerConfig()}
      estimate={{ messageCount: 24, estimatedTokens: 1_200, measuredChats: 12 }}
      frontierBaselineRun={frontierRunFixture()}
      frontierBaselineModel="openai · frontier-test"
      frontierBaselineProject="Cross-System Operations"
      frontierBaselineRunning
      onCancel={() => undefined}
      onCancelFrontierBaseline={() => undefined}
      onConfigChange={() => undefined}
      onRunFrontierBaseline={() => undefined}
      onScan={() => undefined}
      run={null}
      scanning={false}
    />);
    expect(html).toContain("Evidence chats are attached to Cross-System Operations");
    expect(html).toContain("Cancel baseline");
    expect(html).toContain("4 of 15 tasks");
    expect(html).toContain("Collections Prioritization");
    expect(html).toContain('value="4"');
  });

  test("requires the imported Cross-System project before starting live evidence", () => {
    const html = renderToStaticMarkup(<TrainingAutomaticScopeStep
      chatCount={0}
      config={minerConfig()}
      estimate={{ messageCount: 0, estimatedTokens: 0, measuredChats: 0 }}
      frontierBaselineRun={null}
      frontierBaselineModel="openai · frontier-test"
      frontierBaselineProject={null}
      frontierBaselineRunning={false}
      onCancel={() => undefined}
      onCancelFrontierBaseline={() => undefined}
      onConfigChange={() => undefined}
      onRunFrontierBaseline={() => undefined}
      onScan={() => undefined}
      run={null}
      scanning={false}
    />);
    expect(html).toContain("Import the Cross-System Operations Agent SDK project through Make Agent");
    expect(html).toContain("Run frontier baseline</button>");
    expect(html).toContain("disabled");
  });

  test("shows cancellable durable progress while Miner ingests local evidence", () => {
    const timestamp = "2026-07-14T00:00:00.000Z";
    const run = TaskMinerRunSchema.parse({
      schemaVersion: "openpond.taskMinerRun.v1",
      id: "task_miner_run_ingesting",
      profileId: "default",
      status: "running",
      config: minerConfig(),
      sourceIds: ["source_1"],
      sessionIds: ["session_1", "session_2", "session_3"],
      progress: { stage: "ingesting", processedSources: 8, totalSources: 471, candidatesFound: 0, skippedSources: 2 },
      candidateIds: [],
      cancelRequested: false,
      error: null,
      createdAt: timestamp,
      startedAt: timestamp,
      completedAt: null,
      updatedAt: timestamp,
    });
    const html = renderToStaticMarkup(<TrainingAutomaticScopeStep
      chatCount={471}
      config={minerConfig()}
      estimate={{ messageCount: 0, estimatedTokens: 0, measuredChats: 0 }}
      frontierBaselineRun={null}
      frontierBaselineModel="openai · frontier-test"
      frontierBaselineProject="Cross-System Operations"
      frontierBaselineRunning={false}
      onCancel={() => undefined}
      onCancelFrontierBaseline={() => undefined}
      onConfigChange={() => undefined}
      onRunFrontierBaseline={() => undefined}
      onScan={() => undefined}
      run={run}
      scanning
    />);
    expect(html).toContain("Preparing local evidence");
    expect(html).toContain("8 of 471 chats");
    expect(html).toContain("2 skipped");
    expect(html).toContain("Cancel scan");
    expect(html).toContain('value="8"');
  });

  test("does not send an advanced workflow back to candidates when persisted Miner state refreshes", () => {
    const succeeded = TaskMinerRunSchema.parse({
      schemaVersion: "openpond.taskMinerRun.v1",
      id: "task_miner_run_succeeded",
      profileId: "default",
      status: "succeeded",
      config: minerConfig(),
      sourceIds: ["source_1"],
      sessionIds: ["session_1"],
      progress: { stage: "complete", processedSources: 1, totalSources: 1, candidatesFound: 1, skippedSources: 0 },
      candidateIds: ["task_candidate_1"],
      cancelRequested: false,
      error: null,
      createdAt: "2026-07-14T00:00:00.000Z",
      startedAt: "2026-07-14T00:00:00.000Z",
      completedAt: "2026-07-14T00:00:01.000Z",
      updatedAt: "2026-07-14T00:00:01.000Z",
    });

    expect(shouldRevealMinerCandidates("automatic_scope", succeeded)).toBe(true);
    expect(shouldRevealMinerCandidates("automatic_candidates", succeeded)).toBe(false);
    expect(shouldRevealMinerCandidates("evidence", succeeded)).toBe(false);
    expect(shouldRevealMinerCandidates("recommendation", succeeded)).toBe(false);
  });
});

function minerConfig() {
  return { schemaVersion: "openpond.taskMinerConfig.v1" as const, enabled: true, localOnly: true, observationWindowDays: 30, minimumRecurrence: 3, clustering: "hybrid_deterministic_first" as const, consentRequired: true };
}

function frontierRunFixture() {
  return CrossSystemFrontierBaselineRunSchema.parse({
    schemaVersion: "openpond.crossSystemFrontierBaselineRun.v1",
    id: "cso_frontier_run_fixture",
    profileId: "default",
    localProjectId: "local_cross_system",
    localProjectName: "Cross-System Operations",
    model: { providerId: "openai", modelId: "frontier-test" },
    reasoningEffort: "high",
    worldSpecs: [
      { seed: 301, split: "train", difficulty: "easy" },
      { seed: 302, split: "validation", difficulty: "medium" },
      { seed: 303, split: "frozen_eval", difficulty: "hard" },
    ],
    status: "running",
    progress: {
      stage: "running",
      completedTasks: 4,
      totalTasks: 15,
      currentTask: { index: 4, taskId: "task_fixture", worldId: "world_fixture", family: "collections_prioritization" },
      outcomes: { correct: 2, incorrect: 1, parseFailure: 0, budgetExhausted: 0, toolSchemaViolation: 0, infrastructureFailure: 1, cancelled: 0 },
    },
    sourceIds: ["source_1", "source_2", "source_3", "source_4"],
    reboundSessionCount: 15,
    result: null,
    cancelRequested: false,
    error: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    startedAt: "2026-07-14T00:00:01.000Z",
    completedAt: null,
    updatedAt: "2026-07-14T00:00:04.000Z",
  });
}

function dialogProps() {
  return {
    defaultModel: { providerId: "custom-openai-compatible" as const, modelId: "fixture-author" },
    initialSessionIds: [],
    onClose: () => undefined,
    onTasksetCreated: () => undefined,
    preferences: { defaultModelRef: null, creationMode: "defaults" as const, autoApproveEvidence: false },
    providerSettings: null,
    reasoningEffort: "high" as const,
    sessions: [],
    sources: [],
    training: controller(),
  };
}

function creationFixture(state: "recommendation_ready" | "awaiting_materialization_approval", sourceIds: string[]) {
  return TaskCreationSnapshotSchema.parse({
    schemaVersion: "openpond.taskCreationSnapshot.v1",
    id: "creation_fixture",
    request: {
      schemaVersion: "openpond.taskCreationRequest.v1",
      id: "request_fixture",
      profileId: "default",
      surface: "training_page",
      mode: "defaults",
      objective: null,
      methodHint: null,
      sourceIds,
      candidateId: null,
      analysisModel: { providerId: "custom-openai-compatible", modelId: "fixture-author" },
      analysisReasoningEffort: "high",
      createdAt: "2026-07-13T00:00:00.000Z",
    },
    state,
    proposal: proposalFixture(sourceIds),
    materializedTasksetId: null,
    disclosureApprovalId: "disclosure_fixture",
    materializationApprovalId: "materialization_fixture",
    blockingQuestions: [],
    transcript: [],
    repairHistory: [],
    blockedReason: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  });
}

function controller() {
  return {
    payload: null,
    loading: false,
    busyAction: null,
    error: null,
    refresh: async () => null,
    actions: new Proxy({ estimateSources: async () => [] }, { get: (target, key) => key in target ? target[key as keyof typeof target] : async () => null }),
  } as any;
}
