import {
  contentHash,
  createHarnessEvaluationReviewReceipt,
  type HarnessReviewEvidenceRef,
} from "@openpond/harness";

import { createModelImprovementQualificationReceipt } from "./model-improvement-qualification.js";

const createdAt = "2026-08-08T12:00:00.000Z";
const harnessRelease = ref("harness-release");
const sourcePolicy = {
  policy: ref("source-policy"),
  state: "authorized" as const,
  checkedAt: createdAt,
};
const evidence = (id: string, kind: HarnessReviewEvidenceRef["kind"]) => ({
  evidence: ref(id),
  kind,
  sourceRef: `source-${id}`,
  sourcePolicy,
  occurrenceKey: contentHash(`occurrence-${id}`),
  occurredAt: createdAt,
});
const watermark = {
  cursor: contentHash("review-watermark"),
  throughCreatedAt: createdAt,
};
const claim = (family: string, count = 3) => ({
  fingerprint: contentHash(`claim-${family}`),
  recurrenceFamily: family,
  statement: `The ${family} behavior remains unresolved after smaller-layer triage.`,
  independentOccurrences: count,
  unresolvedOccurrences: count,
});

const noAction = createHarnessEvaluationReviewReceipt({
  schemaVersion: "openpond.harnessEvaluationReviewReceipt.v1",
  id: "review-no-action",
  ownerScope: { kind: "personal", id: "owner-1" },
  workspaceRef: "workspace-1",
  harnessRelease,
  previousWatermark: null,
  nextWatermark: watermark,
  selectedEvidence: [],
  excludedEvidence: [],
  claim: null,
  classification: "no_action",
  triage: [],
  reason: "The bounded evidence window contains no unresolved reusable claim.",
  nextAuthority: "none",
  maxEstimatedCostUsd: 0,
  tasksetProposal: null,
  evaluation: null,
  trainingQualification: null,
  policyVersion: "harness-review-policy-v1",
  createdAt,
  metadata: {},
});

const runtime = createHarnessEvaluationReviewReceipt({
  ...withoutHash(noAction),
  id: "review-runtime",
  selectedEvidence: [evidence("runtime-failure", "observation")],
  claim: claim("runtime-transport-failure", 1),
  classification: "runtime",
  triage: [
    {
      layer: "runtime",
      status: "unresolved",
      reason: "The adapter failed before model policy could affect the result.",
      evidenceRefs: [ref("runtime-failure")],
    },
  ],
  reason: "A deterministic runtime regression is the smallest correct fix.",
  nextAuthority: "runtime_service",
});

const product = createHarnessEvaluationReviewReceipt({
  ...withoutHash(noAction),
  id: "review-product",
  selectedEvidence: [evidence("product-routing", "route_decision")],
  claim: claim("product-routing-defect", 1),
  classification: "product",
  triage: [
    {
      layer: "product",
      status: "unresolved",
      reason: "The product selected an unrelated Skill for an ordinary Work turn.",
      evidenceRefs: [ref("product-routing")],
    },
  ],
  reason: "Product routing must be corrected before behavioral Evaluation.",
  nextAuthority: "product_team",
});

const taskset = createHarnessEvaluationReviewReceipt({
  ...withoutHash(noAction),
  id: "review-taskset",
  selectedEvidence: [
    evidence("failure-1", "work_outcome"),
    evidence("failure-2", "work_outcome"),
    evidence("failure-3", "work_outcome"),
  ],
  claim: claim("search-budget-allocation"),
  classification: "taskset",
  triage: [
    {
      layer: "harness",
      status: "unresolved",
      reason: "The active research Skill did not resolve three independent failures.",
      evidenceRefs: [ref("failure-1"), ref("failure-2"), ref("failure-3")],
    },
  ],
  reason: "The repeated behavioral claim now needs controlled measurement.",
  nextAuthority: "human_review",
  tasksetProposal: ref("taskset-proposal"),
  maxEstimatedCostUsd: 2,
});

const blockedRl = createModelImprovementQualificationReceipt({
  schemaVersion: "openpond.modelImprovementQualificationReceipt.v1",
  id: "qualification-rl-blocked",
  review: reference(taskset),
  harnessRelease,
  tasksetRelease: ref("taskset-release"),
  baselineEvaluation: ref("baseline-evaluation"),
  model: modelRef(),
  environmentHash: contentHash("environment"),
  toolContractHash: contentHash("tools"),
  permissionContractHash: contentHash("permissions"),
  policyHash: contentHash("policy"),
  verifierRef: ref("verifier"),
  sourcePolicies: [sourcePolicy],
  trainingEvidenceRefs: [ref("training-evidence")],
  frozenEvaluationEvidenceRefs: [ref("frozen-evidence")],
  privacyApproval: ref("privacy-approval"),
  budgetApproval: ref("budget-approval"),
  maximumCostUsd: 25,
  signal: {
    kind: "scalar_reward",
    strength: "weak",
    calibrated: true,
    confounded: false,
    variance: 0,
    evidenceRefs: [ref("reward-audit")],
  },
  decision: "no_training",
  reasons: ["The observed reward is constant and cannot support RL."],
  createdAt,
  metadata: { blockedMethod: "rl" },
});

const qualifiedRl = createModelImprovementQualificationReceipt({
  ...withoutHash(blockedRl),
  id: "qualification-rl-qualified",
  signal: {
    kind: "scalar_reward",
    strength: "usable",
    calibrated: true,
    confounded: false,
    variance: 0.18,
    evidenceRefs: [ref("reward-audit")],
  },
  decision: "rl",
  reasons: [
    "The frozen baseline has usable variance and a calibrated sequential reward.",
  ],
});

const modelImprovement = createHarnessEvaluationReviewReceipt({
  ...withoutHash(noAction),
  id: "review-model-improvement",
  selectedEvidence: [
    evidence("baseline-evaluation", "evaluation"),
    evidence("qualification-rl-qualified", "training_qualification"),
  ],
  claim: claim("search-budget-allocation"),
  classification: "model_improvement",
  triage: [
    {
      layer: "model",
      status: "unresolved",
      reason:
        "Harness, runtime, product, retrieval, and tool triage left a qualified sequential policy gap.",
      evidenceRefs: [ref("baseline-evaluation"), reference(qualifiedRl)],
    },
  ],
  reason:
    "The qualified claim may proceed to a separately approved managed-training plan.",
  nextAuthority: "training_system",
  tasksetProposal: ref("taskset-proposal"),
  evaluation: ref("baseline-evaluation"),
  trainingQualification: reference(qualifiedRl),
  maxEstimatedCostUsd: 25,
});

export const harnessEvaluationReviewConformance = {
  noAction,
  runtime,
  product,
  taskset,
  blockedRl,
  qualifiedRl,
  modelImprovement,
};

function ref(id: string) {
  return { id, contentHash: contentHash(id) };
}

function reference(value: { id: string; contentHash: string }) {
  return { id: value.id, contentHash: value.contentHash };
}

function withoutHash<T extends { contentHash: string }>(value: T): Omit<T, "contentHash"> {
  const { contentHash: _contentHash, ...content } = value;
  return content;
}

function modelRef() {
  return {
    provider: "openpond",
    model: "openpond-chat",
    revision: "model-revision-1",
    artifactHash: contentHash("model-artifact"),
    tokenizerRevision: "tokenizer-1",
    chatTemplateHash: contentHash("chat-template"),
  };
}
