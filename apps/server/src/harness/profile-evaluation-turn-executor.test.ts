import { expect, test, vi } from "vitest";
import { contentHash } from "@openpond/harness";
import type { RuntimeEvent, Session, Turn } from "@openpond/contracts";
import { createTasksetRunManifest, tasksetRunMetricPolicy } from "@openpond/evals";
import { genericToolConformance } from "@openpond/evals/conformance";

import { createProfileWorkflowEvaluationExecutor } from "./profile-evaluation-turn-executor.js";

const taskset = genericToolConformance.taskset;
const task = taskset.tasks.find((item) => item.split === "frozen_eval")!;
const harnessRelease = { id: genericToolConformance.harness.id, contentHash: genericToolConformance.harness.contentHash };
const modelRef = { providerId: "openpond" as const, modelId: "test-model" };
const profileRef = { source: "local" as const, repositoryId: "repository", profileId: "team-profile" };
const binding = {
  schemaVersion: "openpond.profileWorkflowBinding.v1" as const,
  profileId: profileRef.profileId, sourceRevision: "commit-1", harnessRelease,
  catalogHash: contentHash("workflow-catalog"), workflowId: "report",
};
const source = {
  profileId: binding.profileId, sourceRevision: binding.sourceRevision, harnessRelease,
  catalogHash: contentHash("eval-catalog"), definitionId: "report-check", definitionHash: contentHash("definition"),
  target: { kind: "workflow" as const, workflowId: binding.workflowId }, environmentHash: contentHash("controlled-data"),
};
const modelConfigurationHash = contentHash("configuration");
const manifest = createTasksetRunManifest({
  schemaVersion: "openpond.tasksetRunManifest.v1", id: "workflow-evaluation-run",
  tasksetRelease: { id: taskset.id, contentHash: taskset.contentHash }, packageHash: contentHash("package"),
  execution: { kind: "harness", harnessRelease }, profileEvaluation: source,
  policy: { kind: "model", model: { ...genericToolConformance.manifest.model, provider: modelRef.providerId, model: modelRef.modelId }, configurationHash: modelConfigurationHash },
  gradingRole: "evaluation", metricPolicy: tasksetRunMetricPolicy(taskset),
  population: [{ receiptId: "attempt", taskId: task.id, seed: "1", fixtureId: null }],
  runtimeTarget: genericToolConformance.manifest.runtimeTarget,
  limits: genericToolConformance.manifest.limits,
  createdAt: genericToolConformance.manifest.createdAt,
  metadata: {},
});

test("workflow case runs in an exact source-bound app-server session", async () => {
  const createSession = vi.fn(async () => ({ id: "evaluation-session" }) as Session);
  const sendTurn = vi.fn(async () => ({
    id: "evaluation-turn", status: "completed", startedAt: manifest.createdAt,
    completedAt: manifest.createdAt, modelRef,
    harnessSnapshot: { harnessRelease },
  }) as Turn);
  const runtimeEventsForTurn = vi.fn(async () => ([{
    id: "assistant-event", name: "assistant.delta", timestamp: manifest.createdAt, output: "done",
  }] as RuntimeEvent[]));
  const execute = createProfileWorkflowEvaluationExecutor({
    manifest, profileRef, binding, modelRef, modelConfigurationHash,
    createSession, sendTurn, runtimeEventsForTurn,
  });
  const result = await execute({
    task: { id: task.id, input: task.input, policyVisibleContext: { date: "2026-09-23" }, artifactRefs: [], tags: [] },
    seed: "1", source,
  });
  expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
    currentProfile: profileRef, profileWorkflowBinding: binding,
  }));
  expect(sendTurn).toHaveBeenCalledWith("evaluation-session", expect.objectContaining({
    workflowInput: task.input,
    prompt: 'Policy-visible task context:\n{"date":"2026-09-23"}',
  }));
  expect(JSON.stringify(sendTurn.mock.calls[0])).not.toContain("expectedOutput");
  expect(result.evidence.output).toEqual({ text: "done" });
  expect(result.evidence.runtimeEventRefs).toEqual(["assistant-event"]);
  expect(result.terminal).toBe(true);
});

test("workflow case rejects a turn on a different released Harness", async () => {
  const execute = createProfileWorkflowEvaluationExecutor({
    manifest, profileRef, binding, modelRef, modelConfigurationHash,
    createSession: async () => ({ id: "evaluation-session" }) as Session,
    sendTurn: async () => ({
      id: "evaluation-turn", status: "completed", startedAt: manifest.createdAt,
      completedAt: manifest.createdAt, modelRef,
      harnessSnapshot: { harnessRelease: { id: "other", contentHash: contentHash("other") } },
    }) as Turn,
    runtimeEventsForTurn: async () => [],
  });
  await expect(execute({
    task: { id: task.id, input: task.input, policyVisibleContext: {}, artifactRefs: [], tags: [] },
    seed: "1", source,
  })).rejects.toThrow("different Harness release");
});
