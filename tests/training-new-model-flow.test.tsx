import { describe, expect, test } from "vitest";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskCreationSnapshotSchema, TaskMinerRunSchema } from "../packages/contracts/src";
import { TrainingAutomaticScopeStep } from "../apps/web/src/components/training/TrainingAutomaticScopeStep";
import { TrainingBaseModelStep } from "../apps/web/src/components/training/TrainingBaseModelStep";
import { CreateImproveAuthoringDialog } from "../apps/web/src/components/create-improve/CreateImproveAuthoringDialog";
import { shouldRevealMinerCandidates } from "../apps/web/src/components/training/training-flow";
import { TrainingDatasetStep } from "../apps/web/src/components/training/TrainingDatasetStep";
import { TrainingSourceStep } from "../apps/web/src/components/training/TrainingSourceStep";
import { TrainingStartModeStep } from "../apps/web/src/components/training/TrainingStartModeStep";
import { TrainingRunReviewStep } from "../apps/web/src/components/training/TrainingRunReviewStep";
import { proposalFixture, sourceFixture, tasksetFixture } from "./helpers/training-fixtures";

describe("New model flow", () => {
  test("starts from user intent rather than asking for an optimizer", () => {
    const html = renderToStaticMarkup(<CreateImproveAuthoringDialog {...dialogProps()} initialObjective={null} />);
    expect(html).toContain("Choose a setup");
    expect(html).toContain("Automatic");
    expect(html).toContain("Manual");
    expect(html).toContain("selected chats");
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
    const managed = baseModelCandidate({
      key: "managed",
      modelId: "accounts/fireworks/models/qwen3-8b",
      label: "Qwen3 8B",
      source: "managed",
      sourceLabel: "Fireworks",
    });
    const local = baseModelCandidate({
      key: "local",
      modelId: "HuggingFaceTB/SmolLM2-135M-Instruct",
      label: "SmolLM2 135M Instruct",
      source: "local",
      sourceLabel: "Hugging Face · This machine",
      nonProduction: true,
    });
    const unavailable = baseModelCandidate({
      key: "cuda",
      modelId: "local/cuda-model",
      label: "Local CUDA model",
      source: "local",
      sourceLabel: "This machine",
      available: false,
      unavailableReason: "CUDA worker conformance is missing.",
    });
    const html = renderToStaticMarkup(
      <TrainingBaseModelStep
        busy={false}
        candidates={[managed, local, unavailable]}
        value="local"
        onChange={() => undefined}
        onContinue={() => undefined}
        onManage={() => undefined}
        onScan={() => undefined}
      />,
    );

    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Available base models"');
    expect(html).toContain('aria-label="Starting-weight choices"');
    expect(html).toContain("training-base-model-scroll");
    expect(html).toContain("Qwen3 8B");
    expect(html).toContain("SmolLM2 135M Instruct");
    expect(html).toContain("Managed");
    expect(html).toContain("This machine");
    expect(html).toContain("CUDA worker conformance is missing.");
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("Fireworks");
    expect(html).toContain("LoRA");
    expect(html).toContain("Non-production");
    expect(html).toContain("Manage local models");
    expect(html).toContain("Scan this machine");
    expect(html).toContain("training-dialog-actions training-base-model-actions");
    expect(html).not.toContain("training-inline-actions training-base-model-actions");
    expect(html).not.toContain("Only verified trainable weights");
    expect(html).not.toContain("training-base-model-toolbar");
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
    expect(html).toContain("Automatic");
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

  test("gives Agent authoring a dedicated two-source choice while open targets keep the shared setup", () => {
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
    expect(agent).toContain("From prompt");
    expect(agent).toContain("From chats");
    expect(agent).not.toContain(">Automatic<");
    expect(agent).not.toContain(">Manual<");
    expect(agent.match(/role="radio"/g)).toHaveLength(2);
    expect(generic).toContain("Automatic");
    expect(generic).toContain("Manual");
    expect(agent).toContain('aria-label="New agent"');
    expect(generic).toContain('aria-label="New change"');
  });

  test("keeps Agent prompt-only authoring free of chat search and requires purpose", () => {
    const html = renderToStaticMarkup(
      <TrainingSourceStep
        {...manualSourceProps()}
        mode="from_prompt"
        targetLabel="agent"
      />,
    );
    expect(html).toContain("Agent purpose");
    expect(html).toContain("This path does not attach or search your chats.");
    expect(html).toContain("No chats will be attached");
    expect(html).toContain("required");
    expect(html).not.toContain('placeholder="Search chats"');
    expect(html).not.toContain("Add supporting chats");
    expect(html).toContain("disabled");
  });

  test("requires both an Improvement goal and supporting chats for Agent chat authoring", () => {
    const empty = renderToStaticMarkup(
      <TrainingSourceStep
        {...manualSourceProps()}
        mode="from_chats"
        targetLabel="agent"
        targetOperation="improve"
      />,
    );
    expect(empty).toContain("Improvement goal");
    expect(empty).toContain('placeholder="Search chats"');
    expect(empty).toContain("Select at least one supporting chat");
    expect(empty).toContain("disabled");

    const ready = renderToStaticMarkup(
      <TrainingSourceStep
        {...manualSourceProps()}
        estimatesBySessionId={{ chat_1: { messageCount: 4, estimatedTokens: 220 } }}
        mode="from_chats"
        objective="Prioritize billing blockers before adoption risk."
        selectedEntries={[{ sessionId: "chat_1", title: "Acme renewal review", updatedAt: "2026-07-20T12:00:00.000Z", snippet: null }]}
        selectedEstimate={{ messageCount: 4, estimatedTokens: 220, measuredChats: 1 }}
        selectedSessionIds={new Set(["chat_1"])}
        targetLabel="agent"
        targetOperation="improve"
        visibleSessions={[{ sessionId: "chat_1", title: "Acme renewal review", updatedAt: "2026-07-20T12:00:00.000Z", snippet: null }]}
      />,
    );
    expect(ready).toContain("Review selected chats");
    expect(ready).not.toMatch(/<button class="training-button" type="button" disabled=""[^>]*>Review selected chats/);
  });

  test("explains the two Agent chat-sharing actions before analysis", () => {
    const html = renderToStaticMarkup(
      <TrainingSourceStep
        {...manualSourceProps()}
        disclosurePending
        estimatesBySessionId={{ chat_1: { messageCount: 4, estimatedTokens: 220 } }}
        mode="from_chats"
        objective="Prioritize billing blockers before adoption risk."
        selectedEntries={[{ sessionId: "chat_1", title: "Acme renewal review", updatedAt: "2026-07-20T12:00:00.000Z", snippet: null }]}
        selectedEstimate={{ messageCount: 4, estimatedTokens: 220, measuredChats: 1 }}
        selectedSessionIds={new Set(["chat_1"])}
        targetLabel="agent"
        visibleSessions={[{ sessionId: "chat_1", title: "Acme renewal review", updatedAt: "2026-07-20T12:00:00.000Z", snippet: null }]}
      />,
    );
    expect(html).toContain("Review chats before sharing");
    expect(html).toContain("Nothing is sent until you approve");
    expect(html).toContain("Approve chats and build plan");
    expect(html).toContain("Change chats");
    expect(html).not.toContain("Review data access");
    expect(html).not.toContain("Approve and analyze");
  });

  test("keeps Model data-access wording separate from Agent chat-sharing wording", () => {
    const html = renderToStaticMarkup(
      <TrainingSourceStep
        {...manualSourceProps()}
        estimatesBySessionId={{ chat_1: { messageCount: 4, estimatedTokens: 220 } }}
        mode="manual"
        objective="Train a renewal-risk capability."
        selectedEstimate={{ messageCount: 4, estimatedTokens: 220, measuredChats: 1 }}
        selectedSessionIds={new Set(["chat_1"])}
        targetLabel="model"
      />,
    );
    expect(html).toContain("Review data access");
    expect(html).not.toContain("Review selected chats");
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

  test("renders an Agent-specific review without Model and Taskset internals", () => {
    const source = sourceFixture();
    const base = creationFixture("awaiting_materialization_approval", [source.id]);
    const creation = TaskCreationSnapshotSchema.parse({
      ...base,
      request: {
        ...base.request,
        objective: "Monitor customer account health and explain renewal risk.",
        targetIntent: {
          kind: "agent",
          id: null,
          displayName: null,
          operation: "create",
        },
      },
    });
    const html = renderToStaticMarkup(<TrainingRunReviewStep busy={false} creation={creation} onAddChats={() => undefined} onClose={() => undefined} onCreateTaskset={() => undefined} onCreationChange={() => undefined} sources={[source]} training={controller()} />);
    expect(html).toContain("What the Agent should do");
    expect(html).toContain("Supporting chats");
    expect(html).toContain("How OpenPond will check it");
    expect(html).toContain("Continue to Agent plan");
    expect(html).not.toContain("Dataset &amp; Evals");
    expect(html).not.toContain("Recommended training");
    expect(html).not.toContain("Technical method");
    expect(html).not.toContain("Create Taskset");
    expect(html).not.toContain("Workproduct name");
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

  test("requires explicit multi-chat scope for Automatic discovery", () => {
    const chats = [
      { sessionId: "chat_1", title: "Reconcile customer renewal", updatedAt: "2026-07-17T12:00:00.000Z", snippet: null },
      { sessionId: "chat_2", title: "Review billing mismatch", updatedAt: "2026-07-16T12:00:00.000Z", snippet: null },
    ];
    const html = renderToStaticMarkup(<TrainingAutomaticScopeStep {...automaticScopeProps({
      estimatesBySessionId: {
        chat_1: { messageCount: 12, estimatedTokens: 600 },
        chat_2: { messageCount: 12, estimatedTokens: 600 },
      },
      estimate: { messageCount: 24, estimatedTokens: 1_200, measuredChats: 2 },
      matchingSessionCount: 12,
      selectedEntries: chats,
      selectedSessionIds: new Set(["chat_1", "chat_2"]),
      targetLabel: "agent",
      visibleSessions: chats,
    })} />);
    expect(html).toContain("Choose chats to inspect");
    expect(html).toContain("Reconcile customer renewal");
    expect(html).toContain("Review billing mismatch");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Find Agent opportunities</button>");
    expect(html).toContain("reads only the selected chats");
    expect(html).not.toContain("Chats in scope");
    expect(html).not.toContain("Cross-System Operations proof evidence");
    expect(html).not.toContain("frontier baseline");
  });

  test("keeps optional Manual chats collapsed behind target-specific setup copy", () => {
    const html = renderToStaticMarkup(<TrainingSourceStep {...manualSourceProps()} />);
    expect(html).toContain("Dataset purpose");
    expect(html).toContain('<details class="training-manual-chat-seeds">');
    expect(html).toContain("Add supporting chats");
    expect(html).toContain("Optional");
    expect(html).not.toContain('<details class="training-manual-chat-seeds" open="">');
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
    const html = renderToStaticMarkup(<TrainingAutomaticScopeStep {...automaticScopeProps({
      estimate: { messageCount: 0, estimatedTokens: 0, measuredChats: 0 },
      matchingSessionCount: 471,
      run,
      scanning: true,
      selectedSessionIds: new Set(Array.from({ length: 471 }, (_, index) => `chat_${index}`)),
    })} />);
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

function baseModelCandidate(input: {
  key: string;
  modelId: string;
  label: string;
  source: "managed" | "local" | "builtin";
  sourceLabel: string;
  available?: boolean;
  nonProduction?: boolean;
  unavailableReason?: string | null;
}) {
  const available = input.available ?? true;
  return {
    schemaVersion: "openpond.baseModelCandidate.v1" as const,
    selectionKey: input.key,
    label: input.label,
    sourceLabel: input.sourceLabel,
    preference: {
      schemaVersion: "openpond.baseModelPreference.v1" as const,
      modelId: input.modelId,
      revision: input.source === "local" ? "revision" : null,
      tokenizerRevision: input.source === "local" ? "tokenizer" : null,
      chatTemplateHash: input.source === "local" ? "template1" : null,
      modelAssetId: input.source === "local" ? `asset_${input.key}` : null,
      source: input.source,
    },
    available,
    nonProduction: input.nonProduction ?? false,
    unavailableReason: input.unavailableReason ?? null,
    methods: ["sft" as const],
    executionOptions: [{
      destinationId: input.source === "managed" ? "fireworks" as const : "local_cpu_fixture" as const,
      available,
      methods: ["sft" as const],
      parameterizations: ["lora" as const],
      nonProduction: input.nonProduction ?? false,
      unavailableReason: input.unavailableReason ?? null,
    }],
  };
}

function minerConfig() {
  return { schemaVersion: "openpond.taskMinerConfig.v1" as const, enabled: true, localOnly: true, observationWindowDays: 30, minimumRecurrence: 3, clustering: "hybrid_deterministic_first" as const, consentRequired: true };
}

function automaticScopeProps(
  overrides: Partial<ComponentProps<typeof TrainingAutomaticScopeStep>> = {},
): ComponentProps<typeof TrainingAutomaticScopeStep> {
  return {
    config: minerConfig(),
    estimatesBySessionId: {},
    estimate: { messageCount: 0, estimatedTokens: 0, measuredChats: 0 },
    matchingSessionCount: 0,
    onCancel: () => undefined,
    onConfigChange: () => undefined,
    onLoadMore: () => undefined,
    onScan: () => undefined,
    onSearchChange: () => undefined,
    onToggleSession: () => undefined,
    onToggleVisible: () => undefined,
    run: null,
    scanning: false,
    search: "",
    searchError: null,
    searchHasMore: false,
    searchIndexedChats: 0,
    searchIndexing: false,
    searchLoading: false,
    searchTotalChats: 0,
    selectedEntries: [],
    selectedSessionIds: new Set(),
    targetLabel: "model",
    visibleSessions: [],
    ...overrides,
  };
}

function manualSourceProps(): ComponentProps<typeof TrainingSourceStep> {
  return {
    authoringModel: "fixture-author",
    authoringProvider: "custom-openai-compatible",
    authoringReasoningEffort: "high",
    busy: false,
    disclosurePending: false,
    estimatesBySessionId: {},
    matchingSessionCount: 2,
    mode: "manual",
    objective: "",
    onAnalyze: () => undefined,
    onApproveDisclosure: () => undefined,
    onAuthoringModelChange: () => undefined,
    onAuthoringProviderChange: () => undefined,
    onAuthoringReasoningEffortChange: () => undefined,
    onDeclineDisclosure: () => undefined,
    onLoadMore: () => undefined,
    onObjectiveChange: () => undefined,
    onReturnToRecommendation: () => undefined,
    onSearchChange: () => undefined,
    onToggleSession: () => undefined,
    onToggleVisible: () => undefined,
    providerSettings: null,
    recommendationAvailable: false,
    search: "",
    searchError: null,
    searchHasMore: false,
    searchIndexedChats: 2,
    searchIndexing: false,
    searchLoading: false,
    searchTotalChats: 2,
    selectedEntries: [],
    selectedEstimate: { messageCount: 0, estimatedTokens: 0, measuredChats: 0 },
    selectedSessionIds: new Set(),
    targetLabel: "dataset",
    visibleSessions: [],
  };
}

function dialogProps() {
  return {
    defaultModel: { providerId: "custom-openai-compatible" as const, modelId: "fixture-author" },
    initialSessionIds: [],
    onClose: () => undefined,
    onOpenComputeSettings: () => undefined,
    onOpenDatasetStorageSettings: () => undefined,
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
