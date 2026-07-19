import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskCreationSnapshotSchema, TaskMinerRunSchema } from "../packages/contracts/src";
import { TrainingAutomaticScopeStep } from "../apps/web/src/components/training/TrainingAutomaticScopeStep";
import { TrainingBaseModelStep } from "../apps/web/src/components/training/TrainingBaseModelStep";
import { CreateImproveAuthoringDialog } from "../apps/web/src/components/create-improve/CreateImproveAuthoringDialog";
import { shouldRevealMinerCandidates } from "../apps/web/src/components/training/training-flow";
import { TrainingDatasetStep } from "../apps/web/src/components/training/TrainingDatasetStep";
import { TrainingStartModeStep } from "../apps/web/src/components/training/TrainingStartModeStep";
import { TrainingRunReviewStep } from "../apps/web/src/components/training/TrainingRunReviewStep";
import { proposalFixture, sourceFixture, tasksetFixture } from "./helpers/training-fixtures";

describe("New model flow", () => {
  test("starts from user intent rather than asking for an optimizer", () => {
    const html = renderToStaticMarkup(<CreateImproveAuthoringDialog {...dialogProps()} initialObjective={null} />);
    expect(html).toContain("Choose a setup");
    expect(html).toContain("Automated");
    expect(html).toContain("Manual");
    expect(html).toContain("OpenPond recommends the training method");
    for (const title of ["Supervised fine-tuning", "Preference tuning", "Reinforcement learning"]) expect(html).not.toContain(title);
    expect(html).not.toContain('placeholder="Search chats"');
    expect(html).not.toContain('aria-label="Back');
  });

  test("offers an existing approved Dataset as a separate Model setup", () => {
    const html = renderToStaticMarkup(
      <TrainingStartModeStep
        allowExistingDataset
        mode="existing_dataset"
        onChange={() => undefined}
        onContinue={() => undefined}
      />,
    );
    expect(html).toContain("Existing Dataset");
    expect(html).toContain("without changing its tasks, graders, or held-out Evals");
    expect(html).toContain("training-start-mode-copy");
    expect(html).toContain("training-choice-indicator");
  });

  test("presents base models as choices instead of a form dropdown", () => {
    const html = renderToStaticMarkup(
      <TrainingBaseModelStep
        modelIds={[
          "accounts/fireworks/models/qwen3-0p6b",
          "accounts/fireworks/models/qwen3-8b",
        ]}
        value="accounts/fireworks/models/qwen3-8b"
        onChange={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Available base models"');
    expect(html).toContain("Qwen3 0.6B");
    expect(html).toContain("Qwen3 8B");
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("Fireworks");
    expect(html).toContain("LoRA");
    expect(html).not.toContain("<select");
  });

  test("reuses any ready Dataset even when it predates the dedicated Dataset intent", () => {
    const taskset = tasksetFixture({ ready: true });
    const html = renderToStaticMarkup(
      <TrainingDatasetStep
        busy={false}
        selectedTasksetId={null}
        state={{ tasksets: [taskset] } as any}
        onChange={() => undefined}
        onCreate={() => undefined}
      />,
    );

    expect(taskset.metadata.resourceIntent).toBeUndefined();
    expect(html).toContain("Fixture Taskset");
    expect(html).not.toContain("No reusable Datasets are ready yet");
  });

  test("pre-populated objectives still start at the explicit intent choice", () => {
    const html = renderToStaticMarkup(<CreateImproveAuthoringDialog {...dialogProps()} initialObjective="Reconcile billing and support risk." initialSessionIds={["session_fixture"]} />);
    expect(html).toContain("Automated");
    expect(html).toContain("Manual");
    expect(html).not.toContain("Reconcile billing and support risk.");
    expect(html).not.toContain("Approved support workflow");
  });

  test("reopens a persisted failed Model authoring run with recovery actions", () => {
    const source = sourceFixture();
    const failed = TaskCreationSnapshotSchema.parse({
      ...creationFixture("recommendation_ready", [source.id]),
      state: "failed",
      proposal: null,
      blockedReason: "OpenPond Chat closed the Taskset authoring stream before a proposal was returned.",
      request: {
        ...creationFixture("recommendation_ready", [source.id]).request,
        objective: "Reconcile customer operations.",
        disclosure: {
          ...creationFixture("recommendation_ready", [source.id]).request.disclosure,
          status: "approved",
        },
      },
    });
    const html = renderToStaticMarkup(
      <CreateImproveAuthoringDialog
        {...dialogProps()}
        initialCreation={failed}
        initialObjective={failed.request.objective}
        sources={[source]}
      />,
    );
    expect(html).toContain("Analysis failed");
    expect(html).toContain("Retry approved evidence");
    expect(html).toContain("Change evidence");
    expect(html).toContain("Reconcile customer operations.");
    expect(html).not.toContain("How do you want to start?");
  });

  test("uses the same Automated and Manual shell for Agent and open-target changes", () => {
    const agent = renderToStaticMarkup(<CreateImproveAuthoringDialog
      {...dialogProps()}
      initialObjective={null}
      targetIntent={{ kind: "agent", id: null, displayName: null, operation: "create" }}
    />);
    const generic = renderToStaticMarkup(<CreateImproveAuthoringDialog
      {...dialogProps()}
      initialObjective={null}
      targetIntent={{ kind: null, id: null, displayName: null, operation: "create" }}
    />);
    for (const html of [agent, generic]) {
      expect(html).toContain("Automated");
      expect(html).toContain("Manual");
    }
    expect(agent).toContain('aria-label="New agent"');
    expect(generic).toContain('aria-label="New change"');
  });

  test("renders recommendation review, revision, and Add chats recovery when evidence is insufficient", () => {
    const source = sourceFixture();
    const creation = creationFixture("recommendation_ready", [source.id]);
    const html = renderToStaticMarkup(<TrainingRunReviewStep busy={false} creation={creation} onAddChats={() => undefined} onClose={() => undefined} onCreateTaskset={() => undefined} onCreationChange={() => undefined} sources={[source]} training={controller()} />);
    expect(html).toContain("What it should learn");
    expect(html).toContain("Dataset &amp; Evals");
    expect(html).toContain("Advanced");
    expect(html).toContain(">Add chats</button>");
    expect(html).not.toContain(">Create Taskset</button>");
  });

  test("offers model creation only after a trainable proposal has independent evaluation", () => {
    const train = sourceFixture();
    const evaluation = sourceFixture("source_eval", "cluster_eval");
    const creation = creationFixture("awaiting_materialization_approval", [train.id, evaluation.id]);
    const html = renderToStaticMarkup(<TrainingRunReviewStep busy={false} createLabel="Create model" creation={creation} editDataLabel="Edit Dataset" onAddChats={() => undefined} onClose={() => undefined} onCreateTaskset={() => undefined} onCreationChange={() => undefined} sources={[train, evaluation]} training={controller()} />);
    expect(html).toContain(">Create model</button>");
    expect(html).not.toContain(">Create Taskset</button>");
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
    expect(html).toContain("Primary · Reinforcement / RFT");
    expect(html).toContain("Optional precursor · Supervised / SFT");
    expect(html).toContain("SFT is not GRPO.");
    expect(html).toContain("Runs after creation");
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

  test("shows the actual chat scope without injecting one-off proof controls", () => {
    const html = renderToStaticMarkup(<TrainingAutomaticScopeStep
      chatPreview={[
        { id: "chat_1", title: "Reconcile customer renewal", updatedAt: "2026-07-17T12:00:00.000Z" },
        { id: "chat_2", title: "Review billing mismatch", updatedAt: "2026-07-16T12:00:00.000Z" },
      ]}
      chatCount={12}
      config={minerConfig()}
      estimate={{ messageCount: 24, estimatedTokens: 1_200, measuredChats: 12 }}
      onCancel={() => undefined}
      onConfigChange={() => undefined}
      onScan={() => undefined}
      run={null}
      scanning={false}
    />);
    expect(html).toContain("Review chats in scope");
    expect(html).toContain("Reconcile customer renewal");
    expect(html).toContain("Review billing mismatch");
    expect(html).toContain("Find repeated work</button>");
    expect(html).not.toContain("Cross-System Operations proof evidence");
    expect(html).not.toContain("frontier baseline");
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
      chatPreview={[{ id: "chat_1", title: "Recent work", updatedAt: timestamp }]}
      chatCount={471}
      config={minerConfig()}
      estimate={{ messageCount: 0, estimatedTokens: 0, measuredChats: 0 }}
      onCancel={() => undefined}
      onConfigChange={() => undefined}
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
