import { expect, it } from "vitest";
import { contentHash } from "@openpond/harness";
import { createPreparedTaskAuthoringWorkspace, compileTasksetDraftWorkspace } from "../src/dataset-workspaces.js";
import { createTasksetDraft, TaskDesignProposalSchema, ConnectedDatasetSourceRefSchema } from "../src/taskset-drafts.js";

// An authorer's replacement prompt/answer must never cross the preparation
// boundary into an evaluated policy's input or become independent ground truth.
it("compiles the retained input without admitting authored witnesses or changed starting state", () => {
  const now = "2026-10-01T00:00:00.000Z";
  const source = ConnectedDatasetSourceRefSchema.parse({ schemaVersion: "openpond.connectedDatasetSource.v1", kind: "connected_activity",
    id: "source", profileId: "team", title: "Owned synthetic compilation evidence", sourceHash: "a".repeat(64), occurredAt: now,
    licensingStatus: "approved", secretScanStatus: "passed", piiScanStatus: "passed", origin: "codex", sourceId: "conversation", sessionId: "session",
    normalizerVersion: "connected-evidence-1", projection: "conversation", ownerUserId: "owner", purpose: "recorded_evaluation", metadata: {} });
  const initialInput = { messages: [{ role: "user", content: "Return exactly yes." }] };
  const initialEnvironment = createTasksetDraft({ profileId: "team", id: "environment", now }).environment;
  const provenance = { schemaVersion: "openpond.preparedTaskProvenance.v1" as const, candidateId: "candidate", preparationId: "preparation", familyKey: "family",
    sourceSpans: [{ source: { id: "conversation", snapshotHash: source.sourceHash, boundaryId: "boundary", boundaryRevisionHash: "b".repeat(64) }, startSequence: 0, endSequence: 0, role: "requirement" as const }],
    firstAvailableAt: now, initialInputHash: contentHash(initialInput), initialEnvironmentHash: contentHash(initialEnvironment), sourceScopeHash: "c".repeat(64) };
  const proposal = TaskDesignProposalSchema.parse({ schemaVersion: "openpond.taskDesignProposal.v1", id: "proposal", name: "Exact literal",
    objective: "Return the requested literal", taskKind: "chat", sourceIds: [source.id], assumptions: [], successCriteria: ["Return exactly yes."],
    proposedGraders: [{ id: "literal", version: "1", label: "Required literal", kind: "content", config: { match: "exact", expected: "yes" },
      weight: 1, hardGate: true, rewardEligible: true, privileged: false, metadata: {} }],
    graderFixtures: [{ id: "good", taskIndex: 0, label: "positive", output: { text: "yes" }, infrastructureError: null, expectedPassed: true, expectedRewardEligible: true },
      { id: "bad", taskIndex: 0, label: "negative", output: { text: "no" }, infrastructureError: null, expectedPassed: false, expectedRewardEligible: false }],
    proposedExamples: [{ id: "example", sourceId: source.id, sourceTurnId: null, split: "train", origin: "expert_authored",
      inputPrompt: "UNTRUSTED AUTHOR REPLACEMENT", expectedOutputText: "UNTRUSTED HISTORICAL ANSWER", rationale: "Synthetic proposed witness" }],
    proposedMethod: "grpo", policy: { policyVisibleFields: ["expectedOutput"], privilegedFields: [] }, createdAt: now });
  const input = { teamId: "team", provenance, initialInput, initialEnvironment, proposal, sources: [source], skillHash: "d".repeat(64), modelId: "researcher", attempt: 1, createdAt: now };
  const workspace = createPreparedTaskAuthoringWorkspace(input);
  const compiled = compileTasksetDraftWorkspace({ workspace, preparation: null, adapterId: "preparation-compilation-proof", now });
  expect(compiled.taskset.tasks[0]!.input).toEqual(initialInput);
  expect(compiled.taskset.tasks[0]!.expectedOutput).toBeNull();
  expect(compiled.taskset.tasks[0]!.split).toBe("validation");
  expect(compiled.taskset.policy.policyVisibleFields).toEqual(["input"]);
  expect(compiled.taskset.graders.every((grader) => grader.privileged)).toBe(true);
  expect(JSON.stringify(compiled)).not.toContain("UNTRUSTED AUTHOR REPLACEMENT");
  expect(JSON.stringify(compiled)).not.toContain("UNTRUSTED HISTORICAL ANSWER");
  expect(workspace.draft.graderFixtures.every((fixture) => fixture.metadata.independentlyQualified === false)).toBe(true);
  expect(() => createPreparedTaskAuthoringWorkspace({ ...input, initialInput: { prompt: "Changed" } })).toThrow(/reconstruction/);
  expect(() => createPreparedTaskAuthoringWorkspace({ ...input, initialEnvironment: { ...initialEnvironment, stateful: true } })).toThrow(/reconstruction/);
  expect(() => createPreparedTaskAuthoringWorkspace({ ...input, proposal: { ...proposal, proposedExamples: [proposal.proposedExamples[0]!, proposal.proposedExamples[0]!] } })).toThrow(/exactly one/);
  expect(() => createPreparedTaskAuthoringWorkspace({ ...input, proposal: { ...proposal, graderFixtures: proposal.graderFixtures.map((fixture) => ({ ...fixture, metadata: { substituteExpectedOutput: true } })) } })).toThrow(/historical answer/);
});
