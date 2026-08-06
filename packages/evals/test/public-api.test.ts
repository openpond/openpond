import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  genericToolConformance,
  marketingPortfolioConformance,
} from "../src/conformance.js";
import { gradeEvidence } from "../src/graders.js";
import {
  executeRuntimeProtocol,
  createHarnessRelease,
  type HarnessRuntime,
  type ModelAction,
} from "../src/harness.js";
import { createVerifiedHarnessCompatibilityReceipt } from "../src/compatibility.js";
import { validateTasksetRelease } from "../src/tasksets.js";
import { verifyAttemptReceipt } from "../src/runs.js";
import {
  aggregateEvaluationReceipts,
  assertComparableRunManifests,
  createAttemptReceipt,
  createHarnessCompatibilityReceipt,
  createRunManifest,
  rewardEligibleReceipts,
} from "../src/runs.js";
import { policyTaskView, trainingPolicyTaskViews } from "../src/tasksets.js";
import { contentHash, sha256 } from "../src/common.js";
import { verifyWorkEvidenceReceipt, workEvidenceConformance } from "../src/evidence/index.js";
import { createImprovementObservation } from "../src/harness-improvements.js";
import { createHarnessRunOverlay } from "../src/harness-workspaces.js";

const artifact = {
  id: "artifact-trace",
  contentHash: contentHash("trace"),
  mediaType: "application/json",
  sizeBytes: 5,
};

describe("public package conformance", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["The quick brown fox jumps over the lazy dog", "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"],
    ["OpenPond 🐸", "da0a643a3c08da1791bc7e01a5060048a113557cc586101f1978c4ec07acfd2e"],
  ])("hashes the standard UTF-8 vector %j without a host crypto dependency", (value, expected) => {
    expect(sha256(value)).toBe(expected);
  });

  it("hashes binary input without converting it to text", () => {
    expect(sha256(Uint8Array.of(0, 1, 2, 255))).toBe(
      "3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56",
    );
  });

  it.each([0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 1_000_000])(
    "matches the host reference across the %i-byte padding boundary",
    (length) => {
      const value = Uint8Array.from({ length }, (_, index) => (index * 31 + 17) & 0xff);
      const expected = createHash("sha256").update(value).digest("hex");
      expect(sha256(value)).toBe(expected);
    },
  );

  it.each([
    ["generic", genericToolConformance],
    ["marketing", marketingPortfolioConformance],
  ])("validates and executes the %s fixture through the same protocol", async (_name, fixture) => {
    const report = validateTasksetRelease(fixture.taskset);
    expect(report.valid).toBe(true);
    const calls: string[] = [];
    const runtime: HarnessRuntime = {
      async create() { calls.push("create"); return { id: "lease", metadata: {} }; },
      async reset() { calls.push("reset"); },
      async step(_lease, action) {
        calls.push(`step:${action.name}`);
        return { actionId: action.id, turn: action.turn, terminal: true, output: { text: "done" }, artifactRefs: [] };
      },
      async collect() { calls.push("collect"); return { artifactRefs: [artifact], metadata: {} }; },
      async destroy() { calls.push("destroy"); },
    };
    const action: ModelAction = { id: "action-1", turn: 0, kind: "tool_call", name: fixture.harness.tools[0]!.name, arguments: {}, content: null };
    const result = await executeRuntimeProtocol({
      manifest: fixture.manifest,
      taskId: fixture.taskset.tasks[0]!.id,
      seed: "0",
      actions: [action],
      runtime,
      now: fixedClock(),
    });
    expect(result.receipt.terminal).toBe(true);
    expect(result.receipt.failureClass).toBeNull();
    expect(result.receipt.artifactRefs).toEqual([artifact]);
    expect(verifyAttemptReceipt(result.receipt)).toBe(true);
    expect(calls).toEqual(["create", "reset", `step:${action.name}`, "collect", "destroy"]);
    const grades = await gradeEvidence({
      task: fixture.taskset.tasks[0]!,
      evidence: { output: result.output, runtimeEventRefs: [], artifactRefs: [artifact.id] },
      graders: fixture.taskset.graders,
    });
    expect(grades).toHaveLength(1);
    expect(grades[0]).toMatchObject({ passed: true, rewardEligible: true, failureClass: null });
  });

  it("classifies runtime and cleanup failures as reward-ineligible infrastructure failures", async () => {
    let destroyed = false;
    const runtime: HarnessRuntime = {
      async create() { return { id: "lease", metadata: {} }; },
      async reset() {},
      async step() { throw new Error("fixture runtime failed"); },
      async collect() { return { artifactRefs: [], metadata: {} }; },
      async destroy() { destroyed = true; },
    };
    const result = await executeRuntimeProtocol({
      manifest: genericToolConformance.manifest,
      taskId: genericToolConformance.taskset.tasks[0]!.id,
      seed: "0",
      actions: [{ id: "action-1", turn: 0, kind: "tool_call", name: "lookup", arguments: {}, content: null }],
      runtime,
      now: fixedClock(),
    });
    expect(result.receipt.failureClass).toBe("infrastructure_failure");
    expect(result.receipt.terminal).toBe(false);
    expect(destroyed).toBe(true);
  });

  it("rejects split contamination and content-hash drift", () => {
    const fixture = structuredClone(genericToolConformance.taskset);
    fixture.tasks[1]!.clusterKey = fixture.tasks[0]!.clusterKey;
    const report = validateTasksetRelease(fixture);
    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["split_cluster_contamination", "content_hash_mismatch"]),
    );
  });

  it("compares base and candidate evaluations on the exact same releases", () => {
    const base = genericToolConformance.manifest;
    const { contentHash: _baseHash, ...baseContent } = base;
    const candidate = createRunManifest({
      ...baseContent,
      id: "generic-tool-v1-candidate-run",
      model: { ...base.model, model: "scripted-candidate" },
    });
    expect(() => assertComparableRunManifests(base, candidate)).not.toThrow();
    const receipt = createAttemptReceipt({
      schemaVersion: "openpond.attemptReceipt.v1",
      id: "candidate-receipt",
      runManifest: { id: candidate.id, contentHash: candidate.contentHash },
      taskId: genericToolConformance.taskset.tasks[1]!.id,
      seed: "17",
      terminal: true,
      failureClass: null,
      outputHash: contentHash({ text: "done" }),
      traceHash: contentHash("candidate-trace"),
      artifactRefs: [], graderEvidenceRefs: [],
      startedAt: "2026-08-03T00:00:00.000Z",
      completedAt: "2026-08-03T00:00:00.010Z",
      latencyMs: 10, costUsd: 0, legacyAttemptRef: null,
      metadata: { score: 1, passed: true, rewardEligible: true },
    });
    const result = aggregateEvaluationReceipts({ id: "candidate-eval", manifest: candidate, receipts: [receipt] });
    expect(result).toMatchObject({ attemptCount: 1, rewardEligibleCount: 1, meanScore: 1 });
    expect(rewardEligibleReceipts([receipt])).toEqual([receipt]);
  });

  it("requires an explicit compatibility receipt when the Harness changes", () => {
    const base = genericToolConformance.manifest;
    const { contentHash: _baseHash, ...baseContent } = base;
    const candidate = createRunManifest({
      ...baseContent,
      id: "generic-tool-v1-compatible-harness-run",
      harnessRelease: { id: "generic-tool-v1-harness-v2", contentHash: contentHash("harness-v2") },
    });
    expect(() => assertComparableRunManifests(base, candidate)).toThrow(/compatibility receipt/);
    const compatibility = createHarnessCompatibilityReceipt({
      schemaVersion: "openpond.harnessCompatibility.v1",
      id: "generic-tool-v1-harness-compatibility",
      baseHarnessRelease: base.harnessRelease,
      candidateHarnessRelease: candidate.harnessRelease,
      tasksetRelease: base.tasksetRelease,
      environmentHash: contentHash(genericToolConformance.taskset.environment),
      toolContractHash: contentHash(genericToolConformance.taskset.tools),
      policyHash: contentHash(genericToolConformance.taskset.policy),
      graderInterfaceHash: contentHash(genericToolConformance.harness.graderInterface),
      metadata: { reason: "same task environment and grader contract" },
    });
    expect(() => assertComparableRunManifests(base, candidate, compatibility)).not.toThrow();
  });

  it("derives compatibility evidence from immutable releases and rejects contract drift", () => {
    const base = genericToolConformance.harness;
    const { contentHash: _baseHash, ...baseContent } = base;
    const candidate = createHarnessRelease({
      ...baseContent,
      id: "generic-tool-v1-harness-candidate",
      agentSnapshot: {
        id: "generic-tool-v1-agent-candidate",
        contentHash: contentHash("generic-tool-v1-agent-candidate"),
      },
    });
    const compatibility = createVerifiedHarnessCompatibilityReceipt({
      id: "generic-tool-v1-verified-compatibility",
      baseHarnessRelease: base,
      candidateHarnessRelease: candidate,
      tasksetRelease: genericToolConformance.taskset,
      metadata: { reason: "Harness behavior changed without execution-contract drift." },
    });
    expect(compatibility).toMatchObject({
      baseHarnessRelease: {
        id: base.id,
        contentHash: base.contentHash,
      },
      candidateHarnessRelease: {
        id: candidate.id,
        contentHash: candidate.contentHash,
      },
      tasksetRelease: {
        id: genericToolConformance.taskset.id,
        contentHash: genericToolConformance.taskset.contentHash,
      },
      environmentHash: contentHash(genericToolConformance.taskset.environment),
      toolContractHash: contentHash(genericToolConformance.taskset.tools),
      policyHash: contentHash(genericToolConformance.taskset.policy),
    });

    const drifted = createHarnessRelease({
      ...baseContent,
      id: "generic-tool-v1-harness-tool-drift",
      tools: [],
    });
    expect(() =>
      createVerifiedHarnessCompatibilityReceipt({
        id: "generic-tool-v1-invalid-compatibility",
        baseHarnessRelease: base,
        candidateHarnessRelease: drifted,
        tasksetRelease: genericToolConformance.taskset,
      })
    ).toThrow(/tool contract changed/);
  });

  it("keeps frozen tasks and privileged grader state out of policy/training views", () => {
    const taskset = genericToolConformance.taskset;
    const policy = policyTaskView(taskset.tasks[0]!);
    expect(policy).not.toHaveProperty("expectedOutput");
    expect(policy).not.toHaveProperty("privilegedContextRef");
    expect(trainingPolicyTaskViews(taskset).map((task) => task.id)).toEqual(["generic-tool-v1-train"]);
    expect(JSON.stringify(trainingPolicyTaskViews(taskset))).not.toContain("generic-tool-v1-expected");
  });

  it("exports the Work evidence conformance surface", () => {
    expect(verifyWorkEvidenceReceipt(workEvidenceConformance.receipt)).toBe(true);
  });

  it("exports portable Harness workspace and improvement contracts", () => {
    const overlay = createHarnessRunOverlay({
      schemaVersion: "openpond.harnessRunOverlay.v1",
      id: "portable-overlay",
      runId: "portable-run",
      baseHarnessRelease: genericToolConformance.manifest.harnessRelease,
      workspace: {
        workspaceId: "portable-workspace",
        revision: 0,
        sourceRevision: "source-a",
        channelRevision: 1,
      },
      revision: 0,
      status: "active",
      edits: [],
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
      metadata: {},
    });
    const observation = createImprovementObservation({
      schemaVersion: "openpond.improvementObservation.v1",
      id: "portable-observation",
      runRef: "portable-run",
      turnId: "portable-turn",
      harnessRelease: overlay.baseHarnessRelease,
      overlay: {
        id: overlay.id,
        revision: overlay.revision,
        contentHash: overlay.contentHash,
      },
      eventRefs: [{
        id: "portable-event",
        sequence: 1,
        contentHash: contentHash("portable-event"),
      }],
      kind: "tool_failure",
      state: "terminal",
      tool: {
        name: "exec_command",
        invocationKey: contentHash("portable-invocation"),
      },
      deterministicClass: "command_exit_nonzero",
      summary: "A portable command failure fixture.",
      createdAt: "2026-08-03T00:00:00.000Z",
      metadata: {},
    });
    expect(overlay.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(observation.overlay?.contentHash).toBe(overlay.contentHash);
  });
});

function fixedClock(): () => string {
  const values = [
    "2026-08-03T00:00:00.000Z",
    "2026-08-03T00:00:00.010Z",
  ];
  return () => values.shift() ?? "2026-08-03T00:00:00.010Z";
}
