import { expect, it } from "vitest";
import { createLearningTextAsset, learningRef, sealLearningContent, TaskDefinitionSchema } from "@openpond/evals/learning";
import { RewardBindingSchema, RewardReleaseSchema, compileBoundGraders } from "@openpond/evals/rewards";
import { TasksetReleaseSchema } from "@openpond/evals/tasksets";
import { ModelStarterSchema, createModelStarterCreationRequest, parseModelStarterCreationRequest, previewModelStarter, validateModelStarterCreation, validateResolvedModelStarter } from "../src/model-starters.js";
import { OpenPondModelStarterCatalogClient } from "../src/model-starter-catalog.js";

function fixture(visibility: "verifier" | "policy" = "verifier") {
  const asset = createLearningTextAsset({ text: "export function verify({ output, expectedOutput }) { const passed = output.answer === expectedOutput.answer; return { score: Number(passed), passed, feedback: 'Exact answer' }; }", path: "verifier.mjs", mediaType: "application/javascript", visibility });
  const reward = RewardReleaseSchema.parse(sealLearningContent({ schemaVersion: "openpond.rewardRelease.v1", id: "reward", revision: 1, name: "Exact answer", description: "", implementation: { kind: "custom_verifier", verifierRef: asset.asset, exportName: "verify", timeoutMs: 1_000, networkPolicy: "none" }, rawScore: { minimum: 0, maximum: 1 }, assets: [asset.asset] }));
  const binding = RewardBindingSchema.parse(sealLearningContent({ schemaVersion: "openpond.rewardBinding.v1", id: "binding", revision: 1, name: "Answer quality", description: "", sources: [{ graderId: "answer", reward: learningRef(reward), role: "training", normalization: { kind: "identity" }, weight: 1, required: true, hardGate: true, privileged: true, fixtureRefs: [] }], aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" }));
  const definition = TaskDefinitionSchema.parse(sealLearningContent({
    schemaVersion: "openpond.taskDefinition.v1", id: "format", revision: 1, name: "Answers", description: "", instructions: "Return an answer as JSON.", category: "structured", familyNamespace: "answers",
    inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false },
    outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
    rewardBinding: learningRef(binding), harness: null,
    execution: { policy: { policyVisibleFields: ["input", "policyVisibleContext"], privilegedFields: ["expectedOutput"], hiddenGraderRefs: ["answer"], connectedAppScopes: [] }, environment: { protocolVersion: "openpond.environment.v1", kind: "text", entrypoint: "openpond.text.v1", stateful: false, deterministicSeeds: true, lifecycle: ["create", "reset", "step", "collect", "destroy"], networkPolicy: "none", defaultTimeoutMs: 30_000 }, tools: [], capabilities: [] },
  }));
  const tasks = ["train", "frozen_eval"].map((split, index) => ({ id: `task-${index}`, clusterKey: `family-${index}`, split, input: { question: `Question ${index}` }, expectedOutput: { answer: "Answer" }, policyVisibleContext: { instructions: definition.instructions }, privilegedContextRef: null, artifactRefs: [], tags: [] }));
  const taskset = TasksetReleaseSchema.parse(sealLearningContent({ schemaVersion: "openpond.tasksetRelease.v2", id: "taskset", revision: 1, ...definition.execution, tasks, graders: compileBoundGraders(binding, [reward]), metadata: {} }));
  const starter = ModelStarterSchema.parse(sealLearningContent({ schemaVersion: "openpond.modelStarter.v1", id: "starter", revision: 1, name: "Answers", description: "Original structured examples", category: "extraction", taskset: learningRef(taskset), taskDefinition: learningRef(definition), rewardBinding: learningRef(binding), rewards: [learningRef(reward)], assets: [learningRef(asset)], previewTaskIds: ["task-0"], startingModel: { schemaVersion: "openpond.baseModelPreference.v1", modelId: "base", revision: null, tokenizerRevision: null, chatTemplateHash: null, modelAssetId: null, source: "managed" }, supportedMethods: ["sft"], defaultMethod: "sft", provenance: { author: "OpenPond", license: "MIT", sourceDescription: "Original synthetic examples" }, evidence: { verifierFixtures: null, baseline: null, training: null, evaluation: null } }));
  return { starter, taskset, taskDefinition: definition, rewardBinding: binding, rewards: [reward], assets: [asset] };
}

// A corrupted cache or publication must not substitute executable checks,
// mix task families across splits, or expose frozen cases as starter previews.
it("binds starter content, executable dependencies, task schemas and split boundaries", () => {
  const original = fixture();
  expect(validateResolvedModelStarter(original)).toEqual(original);
  expect(() => validateResolvedModelStarter(fixture("policy"))).toThrow("private to its evaluator");
  const missing = structuredClone(original); missing.assets = [];
  expect(() => validateResolvedModelStarter(missing)).toThrow("inventory mismatch");
  const changed = structuredClone(original); changed.assets[0]!.text += " ";
  expect(() => validateResolvedModelStarter(changed)).toThrow();
  const graders = structuredClone(original); graders.taskset.graders[0]!.weight = 0;
  reseal(graders.taskset); graders.starter.taskset = learningRef(graders.taskset); reseal(graders.starter);
  expect(() => validateResolvedModelStarter(graders)).toThrow("executable graders differ");
  const splits = structuredClone(original); splits.taskset.tasks[1]!.clusterKey = splits.taskset.tasks[0]!.clusterKey;
  reseal(splits.taskset); splits.starter.taskset = learningRef(splits.taskset); reseal(splits.starter);
  expect(() => validateResolvedModelStarter(splits)).toThrow("multiple splits");
  const preview = structuredClone(original); preview.starter.previewTaskIds = ["task-1"]; reseal(preview.starter);
  expect(() => validateResolvedModelStarter(preview)).toThrow("preview task is unavailable");
  const invalid = structuredClone(original); invalid.taskset.tasks[0]!.input = { unexpected: true }; reseal(invalid.taskset); invalid.starter.taskset = learningRef(invalid.taskset); reseal(invalid.starter);
  expect(() => validateResolvedModelStarter(invalid)).toThrow("input does not match");
});

function reseal(value: Record<string, unknown> & { contentHash: string }) {
  const { contentHash: _old, ...content } = value;
  value.contentHash = sealLearningContent(content).contentHash;
}

// Package discovery must not silently follow credentialed redirects or accept
// a different immutable package than the user's final selection.
it("separates catalog metadata and exact packages with bounded credentialed transport", async () => {
  const resolved = fixture();
  const calls: string[] = [];
  const client = new OpenPondModelStarterCatalogClient({ baseUrl: "https://catalog.invalid", apiKey: "test-key", teamId: "team", fetch: async (url, init) => {
    calls.push(String(url));
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("X-OpenPond-Team-Id")).toBe("team");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-key");
    return Response.json(String(url).includes("/releases/") ? resolved : { items: [resolved.starter], nextCursor: null });
  } });
  expect((await client.list({ limit: 1 })).items).toEqual([resolved.starter]);
  expect(await client.resolve(learningRef(resolved.starter))).toEqual(resolved);
  await expect(client.resolve({ ...learningRef(resolved.starter), revision: 2 })).rejects.toMatchObject({ code: "starter_catalog_revision_mismatch" });
  expect(calls[0]).toBe("https://catalog.invalid/v1/model-starter-catalog?limit=1");
  let cancelled = false;
  const oversized = new OpenPondModelStarterCatalogClient({ baseUrl: "https://catalog.invalid", apiKey: "test-key", teamId: "team", fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; } })) });
  await expect(oversized.list()).rejects.toMatchObject({ code: "starter_catalog_response_too_large" });
  expect(cancelled).toBe(true);
});

// Transport retries must retain identity while changed user intent gets a new
// identity; callers cannot inject executable content or bypass pinned methods.
it("pins creation intent and projects previews without private task fields", async () => {
  const resolved = fixture();
  const intent = { profileId: "profile", modelId: "model", name: "My answers", starter: learningRef(resolved.starter), startingModel: resolved.starter.startingModel, method: "sft" as const };
  const request = await createModelStarterCreationRequest(intent);
  expect(await createModelStarterCreationRequest(structuredClone(intent))).toEqual(request);
  expect((await createModelStarterCreationRequest({ ...intent, name: "Other answers" })).operationId).not.toBe(request.operationId);
  expect(validateModelStarterCreation(request, resolved).request).toEqual(request);
  expect(() => validateModelStarterCreation({ ...request, method: "grpo" }, resolved)).toThrow("not supported");
  expect(() => validateModelStarterCreation({ ...request, starter: { ...request.starter, revision: 2 } }, resolved)).toThrow("different package revision");
  expect(() => parseModelStarterCreationRequest({ ...request, assets: resolved.assets })).toThrow();
  const preview = previewModelStarter(resolved);
  expect(preview.tasks).toEqual([{ id: "task-0", input: resolved.taskset.tasks[0]!.input, policyVisibleContext: resolved.taskset.tasks[0]!.policyVisibleContext }]);
  expect(preview.counts).toEqual({ train: 1, validation: 0, frozenEvaluation: 1 });
});
