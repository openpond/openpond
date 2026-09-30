import { describe, expect, it } from "vitest";
import type { OpenPondProfileRef } from "@openpond/contracts";

import { inspectProfileEvaluationRun } from "./profile-evaluation-run-inspection.js";
import { readProfileEvaluationPolicyEvidence } from "./profile-evaluation-policy-evidence.js";
import { contentHash } from "@openpond/harness";

describe("Profile evaluation run inspection", () => {
  const profileRef = { source: "openpond_git", repositoryId: "repo-a", profileId: "default" } as OpenPondProfileRef;
  const otherProfileRef = { ...profileRef, repositoryId: "repo-b" };
  const run = {
    profileRef,
    manifest: {
      id: "run-1", contentHash: "a".repeat(64),
      profileEvaluation: { sourceRevision: "b".repeat(40) },
      population: [{ receiptId: "receipt-1", taskId: "task-1", seed: "seed-1" }],
    },
    receiptRefs: [{ id: "receipt-1", contentHash: "c".repeat(64) }],
    gradeRefs: [{ id: "grade-1", contentHash: "d".repeat(64) }],
  };
  const receipt = {
    id: "receipt-1", contentHash: "c".repeat(64), taskId: "task-1", seed: "seed-1",
    runManifest: { id: "run-1", contentHash: "a".repeat(64) },
    artifactRefs: [],
    graderEvidenceRefs: [{ id: "grade-1", contentHash: "d".repeat(64) }],
    latencyMs: 42, costUsd: 0.01, terminal: true,
  };
  const grade = { contentHash: "d".repeat(64), score: 1, passed: true, gradingStatus: "scored", failureClass: null, components: [] };

  it("keeps one Profile's run and mismatched case evidence out of another Profile's view", async () => {
    const store = {
      getProfileEvaluationRun: async () => run,
      getProfileEvaluationReceipt: async () => receipt,
      getProfileEvaluationGrade: async () => grade,
    } as unknown as Parameters<typeof inspectProfileEvaluationRun>[0]["store"];
    await expect(inspectProfileEvaluationRun({ store, profileRef: otherProfileRef, runId: "run-1" })).rejects.toThrow("selected Profile");
    expect(await inspectProfileEvaluationRun({ store, profileRef, runId: "run-1" })).toMatchObject({
      sourceRevision: "b".repeat(40),
      cases: [{ taskId: "task-1", score: 1, passed: true, latencyMs: 42 }],
    });
    const tampered = { ...store, getProfileEvaluationReceipt: async () => ({ ...receipt, taskId: "different-task" }) } as unknown as typeof store;
    await expect(inspectProfileEvaluationRun({ store: tampered, profileRef, runId: "run-1" })).rejects.toThrow("differs from its retained run");
  });

  // A forged pointer or replaced event must not expose another case's output.
  // The existing summary boundary does not resolve retained policy turns.
  it("reads the exact retained policy turn and rejects foreign or changed evidence", async () => {
    const harnessRelease = { id: "harness", contentHash: contentHash("harness") };
    const manifest = { ...run.manifest, profileEvaluation: { sourceRevision: "revision", harnessRelease, target: { kind: "profile" } },
      policy: { kind: "model", model: { provider: "openpond", model: "test-model" } } };
    const events = [{ id: "event", turnId: "turn", name: "assistant.delta", output: "pond" },
      { id: "completed", turnId: "turn", name: "turn.completed", output: "" }];
    const session = { id: "session", currentProfile: profileRef, metadata: {
      profileEvaluationRun: { id: manifest.id, contentHash: manifest.contentHash }, taskId: receipt.taskId, seed: receipt.seed } };
    const turn = { id: "turn", sessionId: session.id, startedAt: "2026-09-30T00:00:00Z", completedAt: "2026-09-30T00:00:01Z",
      prompt: "Return pond", error: null, modelRef: { providerId: "openpond", modelId: "test-model" }, harnessSnapshot: { harnessRelease } };
    const retainedReceipt = { ...receipt, startedAt: turn.startedAt, completedAt: turn.completedAt,
      traceHash: contentHash(events), outputHash: contentHash({ text: "pond" }), metadata: { retainedEvidenceRef: { sessionId: session.id, turnId: turn.id } } };
    const store = { getSession: async () => session, getTurn: async () => turn, runtimeEventsForTurn: async () => events,
      listModelUsageRecords: async () => [] };
    const input = { store, manifest, receipt: retainedReceipt, profileRef } as unknown as Parameters<typeof readProfileEvaluationPolicyEvidence>[0];
    expect(await readProfileEvaluationPolicyEvidence(input)).toMatchObject({ prompt: "Return pond", output: { text: "pond" } });
    expect(await readProfileEvaluationPolicyEvidence({ ...input, eventLimit: 1 })).toMatchObject({
      events: [events[0]], nextEventCursor: "event", eventCount: 2,
    });
    expect(await readProfileEvaluationPolicyEvidence({ ...input, eventLimit: 1, eventAfterId: "event" })).toMatchObject({
      events: [events[1]], nextEventCursor: null,
    });
    await expect(readProfileEvaluationPolicyEvidence({ ...input, eventAfterId: "foreign-event" })).rejects.toThrow("cursor");
    await expect(readProfileEvaluationPolicyEvidence({ ...input, profileRef: otherProfileRef })).rejects.toThrow("admitted case");
    await expect(readProfileEvaluationPolicyEvidence({ ...input, store: { ...input.store,
      runtimeEventsForTurn: async () => [{ ...events[0], output: "changed" }] as never } })).rejects.toThrow("immutable receipt");
    await expect(readProfileEvaluationPolicyEvidence({ ...input, receipt: { ...input.receipt,
      outputHash: contentHash({ text: "different" }) } })).rejects.toThrow("output differs");
  });
});
