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
import { createLearningTextAsset, learningRef, sealLearningContent } from "@openpond/evals/learning";
import { RewardBindingSchema, RewardReleaseSchema } from "@openpond/evals/rewards";
import { ModelTasksetExecutionResourcesSchema } from "openpond-sdk/model-starters";
import { createModelProjectSaveRequest } from "openpond-sdk/model-projects";
import { ordinaryToolTaskset } from "../packages/sdk/test/fixtures/ordinary-tool-taskset.js";
import { prepareImportedTasksetPackage } from "../apps/server/src/training/taskset-package-import.js";
import { materializeImportedTasksetPackage } from "../apps/server/src/training/taskset-package-files.js";
import { createTrainingApi } from "../apps/server/src/training/training-api.js";
import type { Taskset, TasksetDraft } from "@openpond/contracts";
import type { TasksetDraftFile } from "openpond-sdk/model-taskset-authoring";

// A complete ordinary package must run through the same isolated environment
// and owner-recorded grading boundary without inventing a bound starter graph.
it("executes imported ordinary tool packages without a learning-store binding", async () => withTempDirectory("ordinary-tool-owner-", async home => {
  const store = new SqliteStore(home);
  try {
    const prepared = prepareImportedTasksetPackage({ package: ordinaryToolTaskset(), profileId: "profile", name: "Ordinary tool", createdAt: "2026-09-08T08:00:00.000Z" });
    await materializeImportedTasksetPackage({ home, ...prepared });
    await store.upsertTaskset(prepared.taskset);
    let turns = 0;
    let expectedValue = 1;
    const service = createTaskEvaluationService({ store, storeDir: home, modelText: async () => { throw new Error("Text-only execution must not run."); },
      modelStream: async function* (request) {
        expect(JSON.stringify(request.messages)).not.toContain("private-initial-state");
        expect(JSON.stringify(request.messages)).not.toContain("export function");
        if (turns++ === 0) yield { toolCalls: [{ id: "ordinary-inspect", type: "function", function: { name: "inspect", arguments: "{}" } }] };
        else { expect(request.messages.at(-1)).toMatchObject({ role: "tool", content: JSON.stringify({ value: expectedValue }) }); yield { text: String(expectedValue) }; }
      },
    });
    const result = await service.execute({ tasksetId: prepared.taskset.id, taskId: "inspect-task", model: { providerId: "openpond", modelId: "fixture" }, seed: 17, attempt: 0 });
    expect(result.attempt.metadata.environmentStatus).toBe("completed");
    expect(result.attempt.output).toEqual({ text: "1" });
    expect(result.grade, JSON.stringify(result.grade)).toMatchObject({ score: 1, passed: true });
    expect(result.portable.environmentRelease).toEqual(prepared.package.environment);
    expect(prepared.taskset.metadata.taskDefinition).toBeUndefined();
    const evidence = await readStarterToolEvidence({ store, storeDir: home, taskset: prepared.taskset, task: prepared.taskset.tasks[0]!, attempt: result.attempt });
    expect(evidence).toMatchObject({ environment: { collected: true, finalState: { privateToken: "private-initial-state" } } });
    await expect(readStarterToolEvidence({ store, storeDir: home, taskset: prepared.taskset, task: prepared.taskset.tasks[0]!, attempt: { ...result.attempt, id: "copied-attempt" } })).rejects.toThrow("owner-recorded");
    const model = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ id: "ordinary-world-owner", profileId: "profile", name: "Ordinary world owner", objective: null, defaultBaseModel: null, defaultDestinationId: null,
      trainingSetup: { tasksetRef: { id: prepared.taskset.id, revision: prepared.taskset.revision, contentHash: prepared.taskset.contentHash } },
    }, 0));
    const api = createTrainingApi({ store, storeDir: home, evaluation: service } as never);
    const source = await api.request("inspect_taskset_draft_source", { profileId: model.profileId, modelId: model.id, expectedModelRevision: model.revision }) as { sourcePackageHash: string };
    let draft = await api.request("init_taskset_draft", { profileId: model.profileId, sourceRequest: { schemaVersion: "openpond.modelTasksetDraftRequest.v1", operationId: "revise-world", modelId: model.id, expectedModelRevision: model.revision, sourcePackageHash: source.sourcePackageHash } }) as TasksetDraft;
    await expect(api.request("publish_taskset_draft", { draftId: draft.id })).rejects.toThrow("secret scanning");
    // This fixture is original synthetic source. Import itself must not grant
    // the authoring approval; explicitly record its reviewed source status.
    draft = await api.request("save_taskset_draft", { draft: { ...draft, sourceRefs: draft.sourceRefs.map(source => source.schemaVersion === "openpond.uploadedFileDatasetSource.v1"
      ? { ...source, secretScanStatus: "passed", piiScanStatus: "passed", licensingStatus: "approved" } : source) } }) as TasksetDraft;
    const file = await api.request("taskset_draft_file", { profileId: model.profileId, draftId: draft.id, path: "environment/world.js" }) as { draftRevision: number; file: TasksetDraftFile };
    await api.request("save_taskset_draft_file", { profileId: model.profileId, draftId: draft.id, expectedDraftRevision: file.draftRevision, path: file.file.path, expectedFileHash: file.file.contentHash,
      content: { encoding: "utf8", data: file.file.content.data.replace("value: 1", "value: 2") },
    });
    const published = await api.request("publish_taskset_draft", { draftId: draft.id }) as { taskset: Taskset };
    expect(published.taskset.id).not.toBe(prepared.taskset.id);
    expect((await store.getModelProject(model.id))!.trainingSetup.tasksetRef?.contentHash).toBe(published.taskset.contentHash);
    turns = 0; expectedValue = 2;
    const revised = await service.execute({ tasksetId: published.taskset.id, taskId: "inspect-task", model: { providerId: "openpond", modelId: "fixture" }, seed: 17, attempt: 0 });
    expect(revised.attempt.output).toEqual({ text: "2" });
    expect(revised.grade).toMatchObject({ score: 1, passed: true });
    expect(revised.portable.environmentRelease.contentHash).not.toBe(result.portable.environmentRelease.contentHash);
    turns = 0; expectedValue = 1;
    const original = await service.execute({ tasksetId: prepared.taskset.id, taskId: "inspect-task", model: { providerId: "openpond", modelId: "fixture" }, seed: 18, attempt: 0 });
    expect(original.attempt.output).toEqual({ text: "1" });
    expect(original.portable.environmentRelease).toEqual(result.portable.environmentRelease);
  } finally { await store.close(); }
}));

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
    expect(canonical.portable.verifierSetRelease.contentHash).toBe(ModelTasksetExecutionResourcesSchema.parse(taskset.environment.metadata.portableExecutionResources).verifierSet.contentHash);
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

// Rebinding must replace the actual isolated verifier closure, while old
// attempts remain attributable to the original Taskset and grading code.
it("executes the derived verifier revision without retargeting an earlier tool attempt", { timeout: 30_000 }, async () => withTempDirectory("starter-tool-derived-", async home => {
  const store = new SqliteStore(home);
  try {
    const fixture = await starterToolFixture();
    const original = await store.saveModelStarterCreation(fixture);
    const taskset = (await store.getTaskset(original.trainingSetup.tasksetRef!.id))!;
    let turns = 0;
    const service = createTaskEvaluationService({ store, storeDir: home, modelText: async () => { throw new Error("Text adapter must not run."); }, modelStream: async function* () {
      if (turns++ % 2 === 0) yield { toolCalls: [{ id: "write", type: "function", function: { name: "update_email", arguments: JSON.stringify(taskset.tasks[0]!.input) } }] };
      else yield { text: '{"updated":true}' };
    } });
    const attempt = { taskId: taskset.tasks[0]!.id, model: { providerId: "openpond", modelId: "fixture" }, seed: 2, attempt: 0 };
    const before = await service.execute({ ...attempt, tasksetId: taskset.id });
    expect(before.grade).toMatchObject({ score: 1, passed: true });
    const verifier = createLearningTextAsset({ path: "verifier/revised.mjs", mediaType: "application/javascript", visibility: "verifier", text: "export function verify() { return { score: 0, passed: false, feedback: 'Revised private check' }; }" });
    const { contentHash: _rewardHash, ...rewardContent } = fixture.package.rewards[0]!;
    const reward = RewardReleaseSchema.parse(sealLearningContent({ ...rewardContent, revision: 2, implementation: { kind: "custom_verifier", verifierRef: verifier.asset, exportName: "verify", timeoutMs: 2_000, networkPolicy: "none" }, assets: [verifier.asset] }));
    const { contentHash: _bindingHash, ...bindingContent } = fixture.package.rewardBinding;
    const binding = RewardBindingSchema.parse(sealLearningContent({ ...bindingContent, revision: 2, sources: bindingContent.sources.map(source => ({ ...source, reward: learningRef(reward) })) }));
    await store.learningRepository().transaction(original.profileId, async tx => { await tx.put("asset", verifier, 0); await tx.put("reward", reward, 1); await tx.put("binding", binding, 1); });
    const saved = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ id: original.id, profileId: original.profileId, name: original.name, objective: original.objective, defaultBaseModel: original.defaultBaseModel, defaultDestinationId: original.defaultDestinationId, trainingSetup: { ...original.trainingSetup, rewardBindingRef: learningRef(binding) } }, original.revision));
    const after = await service.execute({ ...attempt, tasksetId: saved.trainingSetup.tasksetRef!.id });
    expect(after.grade).toMatchObject({ score: 0, passed: false });
    expect(after.portable.environmentRelease).toEqual(before.portable.environmentRelease);
    expect(after.portable.verifierSetRelease.contentHash).not.toBe(before.portable.verifierSetRelease.contentHash);
    expect(await store.getTasksetRevision(taskset.id, taskset.revision)).toEqual(taskset);
    const oldAgain = await service.execute({ ...attempt, tasksetId: taskset.id, tasksetRef: learningRef(taskset), attempt: 1 });
    expect(oldAgain.grade).toMatchObject({ score: 1, passed: true });
    expect(oldAgain.portable.verifierSetRelease).toEqual(before.portable.verifierSetRelease);
    const beforeInvalidReference = turns;
    await expect(service.execute({ ...attempt, tasksetId: taskset.id, tasksetRef: { ...learningRef(taskset), contentHash: "0".repeat(64) } })).rejects.toThrow("immutable hash");
    expect(turns).toBe(beforeInvalidReference);
  } finally { await store.close(); }
}));
