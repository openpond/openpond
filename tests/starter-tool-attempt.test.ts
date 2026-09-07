import { expect, it, vi } from "vitest";
import { appendFile } from "node:fs/promises";
import { SqliteStore } from "../apps/server/src/store/store.js";
import { createModelStarterCreationService } from "../apps/server/src/training/model-starter-creation-service.js";
import { runPostTrainingEvaluationAttempt } from "../apps/server/src/training/task-evaluation-attempt-runner.js";
import { createTaskEvaluationService } from "../apps/server/src/training/evaluation-service.js";
import { readStarterToolEvidence } from "../apps/server/src/training/starter-tool-evidence.js";
import type { TasksetWorkModelStream } from "../apps/server/src/training/taskset-work-attempt-types.js";
import { starterToolFixture } from "./helpers/starter-tool-fixture.js";
import { withTempDirectory } from "./helpers/temp-directory.js";

// A model claiming success, a copied receipt, or changed artifact bytes must not
// earn the same state Reward as an actual scoped write through the tool runtime.
it("creates, reopens, executes and grades only owner-recorded tool state", { timeout: 30_000 }, async () => withTempDirectory("starter-tool-owner-", async home => {
  const fixture = await starterToolFixture();
  let store = new SqliteStore(home);
  try {
    const service = createModelStarterCreationService({ store, home, catalog: { resolve: async () => fixture }, now: () => fixture.createdAt });
    const saved = await service.create(fixture.request, "profile");
    expect(await service.create(fixture.request, "profile")).toEqual(saved);
    await store.close();
    store = new SqliteStore(home);
    const taskset = (await store.getTaskset(saved.trainingSetup.tasksetRef!.id))!;
    const task = taskset.tasks[0]!;
    expect(taskset.environment).toMatchObject({ kind: "agent", stateful: true, toolNames: ["lookup_account", "update_email"] });
    const modelText = vi.fn(async () => "must not run");
    const run = (id: string, stream: TasksetWorkModelStream) => runPostTrainingEvaluationAttempt({ store, storeDir: home, modelText, crossSystemStream: stream, resultId: id, attemptInput: { tasksetId: taskset.id, task, model: { providerId: "openpond", modelId: "fixture" }, seed: 3, attempt: 0 } });
    let turns = 0;
    const actual = await run("actual_tool_attempt", async function* (request) {
      const visible = JSON.stringify(request.messages);
      expect(visible).not.toContain("PRIVATE_WORLD_SENTINEL");
      expect(visible).not.toContain("export function");
      expect(visible).toContain("region");
      if (turns++ === 0) {
        const argumentsJson = JSON.stringify(task.input);
        yield { text: undefined, usage: undefined, toolCalls: [{ index: 0, id: "update-1", type: "function", function: { name: "update_email", arguments: argumentsJson.slice(0, 12) } }] };
        yield { toolCalls: [{ index: 0, function: { arguments: argumentsJson.slice(12) } }], continuation: { kind: "chat_completions_reasoning", reasoningContent: "provider continuation" } };
      } else {
        expect(request.messages.find(message => message.role === "assistant")?.continuation).toEqual({ kind: "chat_completions_reasoning", reasoningContent: "provider continuation" });
        expect(request.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "update-1" });
        yield { text: '{"updated":true}' };
      }
    });
    expect(actual.metadata).toMatchObject({ environmentStatus: "completed", environmentCleanupComplete: true });
    const evaluation = createTaskEvaluationService({ store, storeDir: home });
    const audit = await evaluation.auditFixtures({ tasksetId: taskset.id });
    expect(audit.passed).toBe(true);
    expect(audit.results).toHaveLength(3);
    let canonicalTurns = 0;
    const canonicalService = createTaskEvaluationService({ store, storeDir: home, modelText, modelStream: async function* () {
      if (canonicalTurns++ === 0) yield { toolCalls: [{ id: "canonical-update", type: "function", function: { name: "update_email", arguments: JSON.stringify(task.input) } }] };
      else yield { text: '{"updated":true}' };
    } });
    const canonical = await canonicalService.execute({ tasksetId: taskset.id, taskId: task.id, model: { providerId: "openpond", modelId: "fixture" }, seed: 2, attempt: 0 });
    expect(canonical.grade).toMatchObject({ score: 1, passed: true });
    expect(canonical.portable.environmentRelease.contentHash).toBe(fixture.package.execution!.environment.contentHash);
    expect(canonical.portable.verifierSetRelease.contentHash).toBe(fixture.package.execution!.verifierSet.contentHash);
    expect(canonical.portable.harnessRelease.program).toEqual(fixture.package.execution!.javascript.module);
    expect(await evaluation.grade({ tasksetId: taskset.id, taskId: task.id, attempt: actual })).toMatchObject({ score: 1, passed: true, rewardEligible: true });
    const claim = await run("false_claim_attempt", async function* () { yield { text: '{"updated":true}' }; });
    expect(await evaluation.grade({ tasksetId: taskset.id, taskId: task.id, attempt: claim })).toMatchObject({ score: 0, passed: false, rewardEligible: true });
    await expect(readStarterToolEvidence({ store, storeDir: home, taskset, task, attempt: { ...actual, id: "forged_attempt" } })).rejects.toThrow("owner-recorded");
    await expect(readStarterToolEvidence({ store, storeDir: home, taskset, task, attempt: { ...actual, modelRef: { providerId: "openpond", modelId: "different" } } })).rejects.toThrow("differs from");
    const [artifact] = await store.listTaskAttemptArtifacts({ attemptId: actual.id });
    await appendFile(artifact!.path, " ");
    await expect(readStarterToolEvidence({ store, storeDir: home, taskset, task, attempt: actual })).rejects.toThrow("byte boundary");
    vi.spyOn(store, "getTaskset").mockResolvedValueOnce({ ...taskset, environment: { ...taskset.environment, entrypoint: "unregistered", kind: "program" } });
    await expect(run("unsupported_attempt", async function* () { throw new Error("must not run"); })).rejects.toThrow("no registered evaluation adapter");
    expect(modelText).not.toHaveBeenCalled();
  } finally { await store.close(); }
}));

// Cancelling the provider must settle before the returned attempt claims
// environment cleanup, and a later attempt must start with a fresh world.
it("settles provider cancellation and rejects incomplete streamed calls", { timeout: 20_000 }, async () => withTempDirectory("starter-tool-cancel-", async home => {
  const store = new SqliteStore(home);
  try {
    const fixture = await starterToolFixture();
    const saved = await store.saveModelStarterCreation(fixture);
    const taskset = (await store.getTaskset(saved.trainingSetup.tasksetRef!.id))!;
    const task = taskset.tasks[0]!;
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let stopped = false;
    const attemptInput = { tasksetId: taskset.id, task, model: { providerId: "openpond", modelId: "fixture" }, seed: 1, attempt: 0 };
    const pending = runPostTrainingEvaluationAttempt({ store, storeDir: home, modelText: async () => { throw new Error("must not run"); }, resultId: "cancelled_tool_attempt", attemptInput: { ...attemptInput, signal: controller.signal }, crossSystemStream: async function* ({ signal }) {
      try {
        started();
        await new Promise<void>((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
        yield { text: "unreachable" };
      } finally { stopped = true; }
    } });
    await ready;
    controller.abort(new Error("test cancellation"));
    const cancelled = await pending;
    expect(stopped).toBe(true);
    expect(cancelled.metadata).toMatchObject({ environmentStatus: "cancelled", environmentCleanupComplete: true });
    const malformed = await runPostTrainingEvaluationAttempt({ store, storeDir: home, modelText: async () => "must not run", resultId: "malformed_tool_attempt", attemptInput, crossSystemStream: async function* () {
      yield { toolCalls: [{ type: "function", function: { name: "update_email", arguments: JSON.stringify(task.input) } }] };
    } });
    expect(malformed.metadata).toMatchObject({ environmentStatus: "policy_failure", environmentCleanupComplete: true });
    const context = await readStarterToolEvidence({ store, storeDir: home, taskset, task, attempt: malformed });
    expect(context).toMatchObject({ environment: { finalState: { accounts: { A: { email: "old@example.test" } } } } });
  } finally { await store.close(); }
}));
