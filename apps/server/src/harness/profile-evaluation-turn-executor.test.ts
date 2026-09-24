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
  limits: { ...genericToolConformance.manifest.limits, maximumSpendUsd: null },
  createdAt: genericToolConformance.manifest.createdAt,
  metadata: {},
});
const { contentHash: _manifestHash, ...manifestContent } = manifest;

test("workflow case runs in an exact source-bound app-server session", async () => {
  const createSession = vi.fn(async () => ({ id: "evaluation-session" }) as Session);
  const sendTurn = vi.fn(async (_sessionId: string, _request: unknown) => ({
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
    workflowInput: {},
    prompt: '{"prompt":"Repeat the protocol."}\n\nPolicy-visible task context:\n{"date":"2026-09-23"}',
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

test("Skill case sends only policy-visible input through its exact component binding", async () => {
  const target = { kind: "skill" as const, skillPath: "skills/reviewer/SKILL.md" };
  const componentBinding = {
    schemaVersion: "openpond.profileComponentBinding.v1" as const,
    profileId: profileRef.profileId, sourceRevision: binding.sourceRevision,
    harnessRelease, target,
  };
  const componentSource = { ...source, target };
  const componentManifest = createTasksetRunManifest({
    ...manifestContent, id: "skill-evaluation-run", profileEvaluation: componentSource,
  });
  const createSession = vi.fn(async () => ({ id: "skill-evaluation-session" }) as Session);
  const sendTurn = vi.fn(async (_sessionId: string, _request: unknown) => ({
    id: "skill-evaluation-turn", status: "completed", startedAt: manifest.createdAt,
    completedAt: manifest.createdAt, modelRef, harnessSnapshot: { harnessRelease },
  }) as Turn);
  const execute = createProfileWorkflowEvaluationExecutor({
    manifest: componentManifest, profileRef, binding: componentBinding,
    modelRef, modelConfigurationHash, createSession, sendTurn,
    runtimeEventsForTurn: async () => ([{
      id: "skill-output", name: "assistant.delta", timestamp: manifest.createdAt, output: "reviewed",
    }] as RuntimeEvent[]),
  });
  const result = await execute({
    task: { id: task.id, input: { instruction: "Review the draft" }, policyVisibleContext: { audience: "staff" }, artifactRefs: [], tags: [] },
    seed: "1", source: componentSource,
  });
  expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
    currentProfile: profileRef, profileComponentBinding: componentBinding,
  }));
  expect(sendTurn).toHaveBeenCalledWith("skill-evaluation-session", expect.objectContaining({
    prompt: '{"instruction":"Review the draft"}\n\nPolicy-visible task context:\n{"audience":"staff"}',
  }));
  expect(sendTurn.mock.calls[0]?.[1]).not.toHaveProperty("workflowInput");
  expect(JSON.stringify(sendTurn.mock.calls)).not.toContain("expectedOutput");
  expect(result.evidence.output).toEqual({ text: "reviewed" });
});

test("Agent action case grades the released action result", async () => {
  const target = { kind: "agent_action" as const, actionId: "calculate" };
  const componentBinding = {
    schemaVersion: "openpond.profileComponentBinding.v1" as const,
    profileId: profileRef.profileId, sourceRevision: binding.sourceRevision,
    harnessRelease, target,
  };
  const componentSource = { ...source, target };
  const componentManifest = createTasksetRunManifest({
    ...manifestContent, id: "action-evaluation-run", profileEvaluation: componentSource,
  });
  const sendTurn = vi.fn(async () => ({
    id: "action-evaluation-turn", status: "completed", startedAt: manifest.createdAt,
    completedAt: manifest.createdAt, modelRef, harnessSnapshot: { harnessRelease },
  }) as Turn);
  const execute = createProfileWorkflowEvaluationExecutor({
    manifest: componentManifest, profileRef, binding: componentBinding,
    modelRef, modelConfigurationHash,
    createSession: async () => ({ id: "action-session" }) as Session,
    sendTurn,
    runtimeEventsForTurn: async () => ([
      { id: "action-result", name: "workspace_action_result", action: "profile_workflow_action", timestamp: manifest.createdAt, output: "42" },
      { id: "assistant-output", name: "assistant.delta", timestamp: manifest.createdAt, output: "The answer is 42." },
    ] as RuntimeEvent[]),
  });
  const result = await execute({
    task: { id: task.id, input: { value: 6 }, policyVisibleContext: {}, artifactRefs: [], tags: [] },
    seed: "1", source: componentSource,
  });
  expect(sendTurn).toHaveBeenCalledWith("action-session", expect.objectContaining({ workflowInput: { value: 6 } }));
  expect(result.evidence.output).toEqual({ text: "42" });
  expect(result.evidence.runtimeEventRefs).toEqual(["action-result", "assistant-output"]);
});

test("Agent action case rejects an assistant summary without an action result", async () => {
  const target = { kind: "agent_action" as const, actionId: "calculate" };
  const componentBinding = {
    schemaVersion: "openpond.profileComponentBinding.v1" as const,
    profileId: profileRef.profileId, sourceRevision: binding.sourceRevision,
    harnessRelease, target,
  };
  const componentSource = { ...source, target };
  const componentManifest = createTasksetRunManifest({
    ...manifestContent, id: "missing-action-result", profileEvaluation: componentSource,
  });
  const execute = createProfileWorkflowEvaluationExecutor({
    manifest: componentManifest, profileRef, binding: componentBinding,
    modelRef, modelConfigurationHash,
    createSession: async () => ({ id: "action-session" }) as Session,
    sendTurn: async () => ({
      id: "action-turn", status: "completed", startedAt: manifest.createdAt,
      completedAt: manifest.createdAt, modelRef, harnessSnapshot: { harnessRelease },
    }) as Turn,
    runtimeEventsForTurn: async () => ([{
      id: "assistant-output", name: "assistant.delta", timestamp: manifest.createdAt, output: "I ran the action.",
    }] as RuntimeEvent[]),
  });
  await expect(execute({
    task: { id: task.id, input: { value: 6 }, policyVisibleContext: {}, artifactRefs: [], tags: [] },
    seed: "1", source: componentSource,
  })).rejects.toThrow("did not produce a released action result");
});

test("whole-Profile case uses the bound release without a workflow input", async () => {
  const target = { kind: "profile" as const };
  const componentBinding = {
    schemaVersion: "openpond.profileComponentBinding.v1" as const,
    profileId: profileRef.profileId, sourceRevision: binding.sourceRevision,
    harnessRelease, target,
  };
  const componentSource = { ...source, target };
  const componentManifest = createTasksetRunManifest({
    ...manifestContent, id: "profile-evaluation-run", profileEvaluation: componentSource,
  });
  const createSession = vi.fn(async () => ({ id: "profile-session" }) as Session);
  const sendTurn = vi.fn(async (_sessionId: string, _request: unknown) => ({
    id: "profile-turn", status: "completed", startedAt: manifest.createdAt,
    completedAt: manifest.createdAt, modelRef, harnessSnapshot: { harnessRelease },
  }) as Turn);
  const execute = createProfileWorkflowEvaluationExecutor({
    manifest: componentManifest, profileRef, binding: componentBinding,
    modelRef, modelConfigurationHash, createSession, sendTurn,
    runtimeEventsForTurn: async () => ([{
      id: "profile-output", name: "assistant.delta", timestamp: manifest.createdAt, output: "complete",
    }] as RuntimeEvent[]),
  });
  const result = await execute({
    task: { id: task.id, input: { request: "Complete the scenario" }, policyVisibleContext: {}, artifactRefs: [], tags: [] },
    seed: "1", source: componentSource,
  });
  expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ profileComponentBinding: componentBinding }));
  expect(sendTurn.mock.calls[0]?.[1]).not.toHaveProperty("workflowInput");
  expect(result.evidence.output).toEqual({ text: "complete" });
});
