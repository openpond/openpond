import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskCreationSnapshotSchema } from "../packages/contracts/src";
import { TrainingRunDialog } from "../apps/web/src/components/training/TrainingRunDialog";
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
});

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
