import { describe, expect, test } from "vitest";

import {
  authorHarnessEvaluationReviewWithModel,
  contentHash,
  createHarnessEvaluationReviewReceipt,
  evaluationReviewMessages,
  verifyHarnessEvaluationReviewReceipt,
} from "../src/index.js";

const createdAt = "2026-08-08T12:00:00.000Z";
const ref = (id: string) => ({ id, contentHash: contentHash(id) });

function noActionInput() {
  return {
    schemaVersion: "openpond.harnessEvaluationReviewReceipt.v1" as const,
    id: "review-no-action",
    ownerScope: { kind: "personal" as const, id: "owner-1" },
    workspaceRef: "workspace-1",
    harnessRelease: ref("harness-release"),
    previousWatermark: null,
    nextWatermark: {
      cursor: contentHash("watermark"),
      throughCreatedAt: createdAt,
    },
    selectedEvidence: [],
    excludedEvidence: [],
    claim: null,
    classification: "no_action" as const,
    triage: [],
    reason: "No unresolved reusable claim was present in the bounded window.",
    nextAuthority: "none" as const,
    maxEstimatedCostUsd: 0,
    tasksetProposal: null,
    evaluation: null,
    trainingQualification: null,
    policyVersion: "review-policy-v1",
    createdAt,
    metadata: {},
  };
}

describe("Harness Evaluation review contracts", () => {
  test("asks the model to audit user-visible outcomes instead of trusting tool success", () => {
    const messages = evaluationReviewMessages({
      evidence: [],
      harnessRelease: ref("harness-release"),
      previousReviews: [],
    });
    expect(messages[0]!.content).toContain("actual user-visible answer and artifacts");
    expect(messages[0]!.content).toContain("missing requested citations or links");
    expect(messages[0]!.content).toContain("hidden metadata do not prove");
    expect(messages[0]!.content).toContain("An applied edit alone is not later-success evidence");
    expect(messages[0]!.content).toContain("Occurrence count is evidence, not the decision rule");
  });

  test("creates and verifies an immutable bounded no-action receipt", () => {
    const receipt = createHarnessEvaluationReviewReceipt(noActionInput());

    expect(verifyHarnessEvaluationReviewReceipt(receipt)).toBe(true);
    expect(receipt).toMatchObject({
      classification: "no_action",
      nextAuthority: "none",
      selectedEvidence: [],
    });
    expect(
      verifyHarnessEvaluationReviewReceipt({
        ...receipt,
        reason: "mutated after hashing",
      }),
    ).toBe(false);
  });

  test("rejects revoked selected evidence and incomplete actionable routing", () => {
    const evidence = {
      evidence: ref("observation-1"),
      kind: "observation" as const,
      sourceRef: "source-1",
      sourcePolicy: {
        policy: ref("source-policy"),
        state: "revoked" as const,
        checkedAt: createdAt,
      },
      occurrenceKey: contentHash("occurrence-1"),
      occurredAt: createdAt,
    };

    expect(() =>
      createHarnessEvaluationReviewReceipt({
        ...noActionInput(),
        id: "review-invalid-taskset",
        selectedEvidence: [evidence],
        claim: {
          fingerprint: contentHash("claim"),
          recurrenceFamily: "document-recovery",
          statement: "Document recovery remains unreliable.",
          independentOccurrences: 3,
          unresolvedOccurrences: 3,
        },
        classification: "taskset",
        nextAuthority: "human_review",
      }),
    ).toThrow(/authorized|proposal/i);
  });

  test("lets the model identify a durable pattern without a fixed occurrence threshold", async () => {
    const evidence = [{
      id: "route-one",
      evidence: ref("route-one"),
      kind: "route_decision" as const,
      sourceRef: "source-one",
      occurredAt: createdAt,
      payload: {
        rawError: "The PDF editor failed before the agent recovered with another supported path.",
        recovered: true,
      },
    }];
    const decision = await authorHarnessEvaluationReviewWithModel({
      evidence,
      harnessRelease: ref("harness-release"),
      stream: async function* () {
        yield { text: JSON.stringify({
          schemaVersion: "openpond.harnessEvaluationReviewModelDecision.v2",
          decision: "review",
          classification: "harness_maintenance",
          selectedEvidenceIds: ["route-one"],
          ignoredEvidence: [],
          recurrenceFamily: "pdf-first-attempt-editing",
          statement: "A supported PDF edit path was discovered only after an avoidable failed attempt.",
          triageLayer: "harness",
          expectedOutcome: "Choose the supported edit path first on equivalent PDF tasks.",
          counterevidence: "Only one independent occurrence is currently available.",
          confidence: 0.72,
          candidateDisposition: "confirm",
          reason: "The recovery is concrete and the proposed personal guidance is low risk.",
        }) };
      },
      signal: new AbortController().signal,
    });

    expect(decision).toMatchObject({
      decision: "review",
      selectedEvidenceIds: ["route-one"],
      recurrenceFamily: "pdf-first-attempt-editing",
    });
  });

  test("binds later-success resolution to a listed candidate and supplied evidence", async () => {
    const evidence = [{
      id: "success-one",
      evidence: ref("success-one"),
      kind: "observation" as const,
      sourceRef: "independent-source",
      occurredAt: createdAt,
      payload: { summary: "Equivalent work succeeded under the applied release." },
    }];
    const candidate = {
      id: "candidate-one",
      fingerprint: contentHash("candidate-one"),
      status: "confirmed",
    };
    let calls = 0;
    const decision = await authorHarnessEvaluationReviewWithModel({
      evidence,
      harnessRelease: ref("harness-release"),
      candidates: [candidate],
      stream: async function* () {
        calls += 1;
        yield { text: JSON.stringify({
          schemaVersion: "openpond.harnessEvaluationReviewModelDecision.v2",
          decision: "resolve_candidate",
          candidateId: "candidate-one",
          candidateFingerprint: calls === 1 ? contentHash("wrong") : candidate.fingerprint,
          selectedEvidenceIds: ["success-one"],
          ignoredEvidence: [],
          confidence: 0.97,
          reason: "Independent equivalent work now satisfies the expected behavior.",
        }) };
      },
      signal: new AbortController().signal,
    });

    expect(calls).toBe(2);
    expect(decision).toMatchObject({
      decision: "resolve_candidate",
      candidateId: "candidate-one",
      candidateFingerprint: candidate.fingerprint,
      selectedEvidenceIds: ["success-one"],
    });
  });

  test("lets the model navigate large evidence windows before full review", async () => {
    const evidence = ["route-one", "route-two", "unrelated"].map((id) => ({
      id,
      evidence: ref(id),
      kind: "route_decision" as const,
      sourceRef: `source-${id}`,
      occurredAt: createdAt,
      payload: {
        summary: id === "unrelated" ? "A separate product issue." : "The PDF renderer failed before recovery.",
        detail: "x".repeat(12_000),
      },
    }));
    let calls = 0;
    let navigatedIds: string[] = [];
    const decision = await authorHarnessEvaluationReviewWithModel({
      evidence,
      harnessRelease: ref("harness-release"),
      stream: async function* ({ messages }) {
        calls += 1;
        if (calls === 1) {
          expect(messages[0]!.content).toContain("only chooses what the full reviewer will inspect");
          expect(messages[1]!.content.length).toBeLessThan(12_000);
          yield { text: JSON.stringify({
            schemaVersion: "openpond.harnessEvaluationReviewNavigationDecision.v1",
            selectedEvidenceIds: ["route-one", "route-two"],
            reason: "Inspect the two semantically related recovered PDF failures.",
          }) };
          return;
        }
        expect(messages[1]!.content).not.toContain('"id": "unrelated"');
        yield { text: JSON.stringify({
          schemaVersion: "openpond.harnessEvaluationReviewModelDecision.v2",
          decision: "review",
          classification: "runtime",
          selectedEvidenceIds: ["route-one", "route-two"],
          ignoredEvidence: [],
          recurrenceFamily: "pdf-renderer-runtime",
          statement: "The same renderer failed across independent tasks.",
          triageLayer: "runtime",
          expectedOutcome: "Provide a compatible renderer.",
          counterevidence: "Both tasks recovered.",
          confidence: 0.9,
          candidateDisposition: null,
          reason: "The recovered failures share a runtime cause.",
        }) };
      },
      signal: new AbortController().signal,
      onNavigation: (navigation) => {
        navigatedIds = navigation.selectedEvidenceIds;
      },
    });

    expect(calls).toBe(2);
    expect(navigatedIds).toEqual(["route-one", "route-two"]);
    expect(decision).toMatchObject({
      decision: "review",
      selectedEvidenceIds: ["route-one", "route-two"],
    });
  });
});
