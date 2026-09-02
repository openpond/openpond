import {
  ContinualBenchmarkProtocolReleaseSchema,
  ContinualBenchIssuePacketSchema,
  ContinualLearningDailyBatchManifestSchema,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import { describe, expect, it } from "vitest";

const NOW = "2026-09-02T02:30:00.000Z";
const hash = (value: unknown) => contentHash(value);
const immutable = (id: string) => ({ id, contentHash: hash(id) });
const taskset = (id: string) => ({ ...immutable(id), revision: 1 });

function protocolInput() {
  const panels = [
    { id: "panel-p0-correction", role: "correction", passLabel: "P0", taskset: taskset("taskset-p0-correction"), familyIds: ["family-p0"], taskCount: 1, sealedAt: NOW },
    { id: "panel-p0-siblings", role: "sibling_verification", passLabel: "P0", taskset: taskset("taskset-p0-siblings"), familyIds: ["family-p0"], taskCount: 3, sealedAt: NOW },
    { id: "panel-known-p0", role: "cumulative_known", passLabel: "P0", taskset: taskset("taskset-known-p0"), familyIds: ["family-p0"], taskCount: 4, sealedAt: NOW },
    { id: "panel-development", role: "development", passLabel: null, taskset: taskset("taskset-development"), familyIds: ["family-development"], taskCount: 4, sealedAt: NOW },
    { id: "panel-retained", role: "retained", passLabel: null, taskset: taskset("taskset-retained"), familyIds: ["family-retained"], taskCount: 4, sealedAt: NOW },
    { id: "panel-frozen", role: "frozen_final", passLabel: null, taskset: taskset("taskset-frozen"), familyIds: ["family-frozen"], taskCount: 4, sealedAt: NOW },
    { id: "panel-training", role: "training_eligible", passLabel: null, taskset: taskset("taskset-training"), familyIds: ["family-p0"], taskCount: 1, sealedAt: NOW },
  ] as const;
  const release = {
    schemaVersion: "openpond.continualBenchmarkProtocol.v1",
    id: "continual-bench-protocol-test",
    revision: 1,
    ownerId: "owner-test",
    createdAt: NOW,
    sealedAt: NOW,
    creationReceipt: immutable("protocol-creation-test"),
    predecessorSeries: null,
    scenarioPack: immutable("scenario-pack-test"),
    issueFamilyLedger: immutable("family-ledger-test"),
    issuePacketRelease: immutable("issue-packets-test"),
    panels,
    grader: immutable("grader-test"),
    judge: null,
    policies: {
      base: { kind: "base_model", id: "base-test", revision: "revision-test", contentHash: hash("base-test") },
      master: null,
      externalReferences: [{ kind: "external_reference", id: "frontier-test", model: { providerId: "codex", modelId: "gpt-5.6-sol" }, providerRevision: "gpt-5.6-sol-2026-09-01", contentHash: hash("frontier-test") }],
    },
    invariants: {
      systemPromptHash: hash("prompt-test"),
      toolSchema: immutable("tools-test"),
      application: immutable("application-test"),
      harness: immutable("harness-test"),
      runtime: immutable("runtime-test"),
      workerImage: immutable("worker-test"),
      autoRefiner: { enabled: false, release: null },
    },
    schedule: [{ scheduleEntryId: "schedule-p0", ordinal: 0, label: "P0", role: "seed", parentRule: "base_model", trainableRank: 16, correctionPanelIds: ["panel-p0-correction"], optimizerGroupsPerTask: 1, trajectoriesPerGroup: 4 }],
    evaluation: { seeds: [1701, 1709, 1721], repetitions: 3, powerRule: immutable("power-test"), pairedBootstrapSamples: 10_000, confidenceLevel: 0.95 },
    resources: { maximumTrainingGpuSeconds: 10_000, maximumEvaluationGpuSeconds: 10_000, maximumProviderSpendUsd: 100, maximumTotalSpendUsd: 1_000, maximumConcurrentGroups: 1 },
    currencyThresholds: { revision: 1, requireAllAttemptsTerminal: true, criticalCorrectionPassRate: 1, siblingPassRate: 0.8, behavioralRetentionRate: 0.95, maximumRetainedRegressionPoints: 5, blockCriticalPriorRegression: true, authorizedClaims: ["systems_complete", "correction_absorbed", "issue_generalized", "continually_current", "frontier_pareto_result"] },
  } as const;
  return { ...release, contentHash: hash(release) };
}

describe("Continual Bench contracts", () => {
  it("accepts a sealed portable benchmark protocol and issue packet", () => {
    expect(ContinualBenchmarkProtocolReleaseSchema.parse(protocolInput()).evaluation.seeds).toHaveLength(3);
    const packetInput = {
      schemaVersion: "openpond.continualBenchIssuePacket.v1",
      id: "issue-packet-test",
      revision: 1,
      familyId: "family-p0",
      familyLabel: "Returns requiring payment-method correction",
      severity: "high",
      cases: [
        { taskId: "task-correction", taskContentHash: hash("task-correction"), panelRole: "correction", passLabel: "P0", optimizerEligible: true, criticalInvariantIds: ["return-completed"] },
        { taskId: "task-sibling", taskContentHash: hash("task-sibling"), panelRole: "sibling_verification", passLabel: "P0", optimizerEligible: false, criticalInvariantIds: ["return-completed"] },
      ],
      duplicateEvidence: immutable("duplicates-test"),
      leakageEvidence: immutable("leakage-test"),
      priorExposureEvidence: immutable("exposure-test"),
      observedAt: NOW,
      reviewedAt: NOW,
      queuedAt: null,
      runAt: null,
      createdBy: "reviewer-test",
      createdAt: NOW,
    } as const;
    expect(ContinualBenchIssuePacketSchema.parse({ ...packetInput, contentHash: hash(packetInput) }).cases).toHaveLength(2);
  });

  it("rejects holdout exposure, missing siblings, shallow groups, and duplicate series-wide panels", () => {
    const correction = { taskId: "task-a", taskContentHash: hash("task-a"), panelRole: "correction", passLabel: "P0", optimizerEligible: true, criticalInvariantIds: [] } as const;
    expect(() => ContinualBenchIssuePacketSchema.parse({
      schemaVersion: "openpond.continualBenchIssuePacket.v1", id: "packet", revision: 1, contentHash: hash("packet"), familyId: "family", familyLabel: "Family", severity: "high",
      cases: [correction, { ...correction, taskId: "task-b", taskContentHash: hash("task-b") }], duplicateEvidence: immutable("d"), leakageEvidence: immutable("l"), priorExposureEvidence: immutable("p"), observedAt: NOW, reviewedAt: NOW, queuedAt: null, runAt: null, createdBy: "reviewer", createdAt: NOW,
    })).toThrow(/sibling/i);
    expect(() => ContinualBenchmarkProtocolReleaseSchema.parse({
      ...protocolInput(),
      schedule: [{ ...protocolInput().schedule[0], trajectoriesPerGroup: 1 }],
    })).toThrow();
    const input = protocolInput();
    expect(() => ContinualBenchmarkProtocolReleaseSchema.parse({
      ...input,
      panels: [...input.panels, { ...input.panels.find((panel) => panel.role === "retained")!, id: "second-retained" }],
    })).toThrow(/exactly one retained/i);
  });

  it("accepts generated receipts and externally captured responses in Evals intake", () => {
    const common = {
      schemaVersion: "openpond.continualLearningDailyBatchManifest.v1" as const,
      id: "evals-intake-test",
      seriesId: "series-test",
      scheduleEntryId: "schedule-p0",
      dayOrdinal: 1,
      sourceTaskset: taskset("taskset-training"),
      taskIds: ["task-a"],
      sourceFileName: "tasks.json",
      availableAt: NOW,
    };
    const imported = ContinualLearningDailyBatchManifestSchema.parse({
      ...common,
      observedAttempts: [{
        taskId: "task-a",
        target: { kind: "captured_model", id: "production-policy-2026-09-02", label: "Production policy" },
        attempt: {
          source: "imported_response",
          modelLabel: "Production policy",
          modelVersionId: null,
          response: { messages: [{ role: "assistant", content: "Handled" }] },
          reward: 0.75,
          components: { terminalState: 1, communication: 0.5 },
        },
      }],
    });
    expect(imported.observedAttempts[0]?.attempt.source).toBe("imported_response");
    expect(typeof imported.observedAttempts[0]?.target).toBe("object");
    const legacy = ContinualLearningDailyBatchManifestSchema.parse({
      ...common,
      observedAttempts: [{ taskId: "task-a", evaluationRunId: "run-a", attemptId: "attempt-a", reward: 1 }],
    });
    expect(legacy.observedAttempts[0]?.attempt.source).toBe("evaluation_run");
  });
});
