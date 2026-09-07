import { TasksetSourceRefSchema } from "@openpond/contracts";
import { EnvironmentReleaseSchema, VerifierSetReleaseSchema } from "@openpond/evals";
import { JavaScriptEnvironmentDefinitionSchema } from "@openpond/evals/javascript-environment";
import { createLearningTextAsset, learningRef, sealLearningContent, TaskDefinitionSchema } from "@openpond/evals/learning";
import { RewardBindingSchema, RewardReleaseSchema, compileBoundGraders } from "@openpond/evals/rewards";
import { TasksetReleaseSchema } from "@openpond/evals/tasksets";
import { ModelStarterSchema, createModelStarterCreationRequest, validateResolvedModelStarter } from "openpond-sdk/model-starters";
import { contentHash } from "@openpond/taskset-sdk";

export async function starterToolFixture() {
  const module = createLearningTextAsset({ path: "environment/accounts.mjs", mediaType: "application/javascript", visibility: "host_private", text: `
export function create({ initialState }) { return { state: initialState, observation: {} }; }
export function reset({ initialState }) { return { state: initialState, observation: { accountIds: Object.keys(initialState.accounts) } }; }
export function step({ state, input, action }) {
  const id = action.arguments.accountId;
  if (!state.accounts[id]) return { state, observation: { error: "unknown_account" } };
  if (action.name === "lookup_account") return { state, observation: { id, email: state.accounts[id].email } };
  if (id !== input.accountId) return { state, observation: { error: "outside_write_scope" } };
  state.accounts[id].email = action.arguments.email;
  return { state, observation: { updated: id } };
}
export function collect({ state }) { return { state, observation: {} }; }
export function destroy() { return { state: {}, observation: {} }; }
` });
  const initialState = createLearningTextAsset({ path: "environment/state.json", mediaType: "application/json", visibility: "host_private", text: JSON.stringify({ privateNote: "PRIVATE_WORLD_SENTINEL", accounts: { A: { email: "old@example.test" }, B: { email: "keep@example.test" } } }) });
  const verifier = createLearningTextAsset({ path: "verifier/state.mjs", mediaType: "application/javascript", visibility: "verifier", text: `export function verify({ input, evaluatorContext }) {
  const environment = evaluatorContext?.environment;
  const state = environment?.finalState;
  const passed = environment?.status === "completed" && environment.collected && state?.accounts?.[input.accountId]?.email === input.email && state.accounts.B.email === "keep@example.test";
  return { score: Number(Boolean(passed)), passed: Boolean(passed), feedback: "Checked owner-recorded account state" };
}` });
  const reward = RewardReleaseSchema.parse(sealLearningContent({ schemaVersion: "openpond.rewardRelease.v1", id: "account-reward", revision: 1, name: "Scoped update", description: "", implementation: { kind: "custom_verifier", verifierRef: verifier.asset, exportName: "verify", timeoutMs: 2_000, networkPolicy: "none" }, rawScore: { minimum: 0, maximum: 1 }, assets: [verifier.asset] }));
  const binding = RewardBindingSchema.parse(sealLearningContent({ schemaVersion: "openpond.rewardBinding.v1", id: "account-binding", revision: 1, name: "Scoped update", description: "", sources: [{ graderId: "account-state", reward: learningRef(reward), role: "training", normalization: { kind: "identity" }, weight: 1, required: true, hardGate: true, privileged: true, fixtureRefs: [] }], aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" }));
  const tools = [
    { name: "lookup_account", description: "Read an account", properties: { accountId: { type: "string" } }, required: ["accountId"], sideEffect: "read" },
    { name: "update_email", description: "Update the authorized account email", properties: { accountId: { type: "string" }, email: { type: "string" } }, required: ["accountId", "email"], sideEffect: "write" },
  ].map(({ properties, required, ...tool }) => {
    const inputSchema = { type: "object", properties, required, additionalProperties: false };
    return { ...tool, inputSchema, inputSchemaHash: contentHash(inputSchema), timeoutMs: 2_000 };
  });
  const javascript = JavaScriptEnvironmentDefinitionSchema.parse(sealLearningContent({ schemaVersion: "openpond.javascriptEnvironment.v1", id: "account-world", revision: 1, module: module.asset, tools, maxSteps: 4, maxStateBytes: 8_192, maxObservationBytes: 8_192, operationTimeoutMs: 2_000 }));
  const environment = EnvironmentReleaseSchema.parse(sealLearningContent({ schemaVersion: "openpond.environmentRelease.v1", id: "account-environment", revision: 1, contract: { protocolVersion: "openpond.environment.v1", kind: "agent", entrypoint: "openpond.javascript-environment.v1", stateful: true, deterministicSeeds: true, lifecycle: ["create", "reset", "step", "collect", "destroy"], networkPolicy: "none", defaultTimeoutMs: 15_000 }, actionSchemaRef: null, observationSchemaRef: null, stateSchemaRef: null, artifactCollection: { maxArtifacts: 1, maxTotalBytes: 33_554_432 }, adapterConformanceHashes: {}, metadata: { javascriptEnvironment: learningRef(javascript) } }));
  const graders = compileBoundGraders(binding, [reward]);
  const verifierSet = VerifierSetReleaseSchema.parse(sealLearningContent({ schemaVersion: "openpond.verifierSetRelease.v1", id: "account-verifiers", revision: 1, graders, isolation: { processBoundary: "isolated_process", networkPolicy: "none", defaultTimeoutMs: 2_000 }, calibrationReceiptRefs: [], metadata: {} }));
  const taskDefinition = TaskDefinitionSchema.parse(sealLearningContent({ schemaVersion: "openpond.taskDefinition.v1", id: "account-format", revision: 1, name: "Account updates", description: "", instructions: "Use the tools to change the requested account email. Return a JSON summary.", category: "structured", familyNamespace: "account-updates", inputSchema: { type: "object", properties: { accountId: { type: "string" }, email: { type: "string" } }, required: ["accountId", "email"], additionalProperties: false }, outputSchema: { type: "object", properties: { updated: { type: "boolean" } }, required: ["updated"], additionalProperties: false }, rewardBinding: learningRef(binding), harness: null, execution: { policy: { policyVisibleFields: ["input", "policyVisibleContext"], privilegedFields: ["expectedOutput", "privilegedContextRef"], hiddenGraderRefs: ["account-state"], connectedAppScopes: [] }, environment: environment.contract, environmentRelease: { id: environment.id, contentHash: environment.contentHash }, verifierSetRelease: { id: verifierSet.id, contentHash: verifierSet.contentHash }, tools: javascript.tools, capabilities: [] } }));
  const taskset = TasksetReleaseSchema.parse(sealLearningContent({ schemaVersion: "openpond.tasksetRelease.v2", id: "account-taskset", revision: 1, ...taskDefinition.execution, graders, tasks: ["train", "frozen_eval"].map((split, index) => ({ id: `account-task-${index}`, clusterKey: `account-family-${index}`, split, input: { accountId: "A", email: `new-${index}@example.test` }, expectedOutput: { updated: true }, policyVisibleContext: { instructions: taskDefinition.instructions, region: "test" }, privilegedContextRef: initialState.id, artifactRefs: [], tags: [] })), metadata: {} }));
  const assets = [module, initialState, verifier];
  const starter = ModelStarterSchema.parse(sealLearningContent({ schemaVersion: "openpond.modelStarter.v1", id: "account-starter", revision: 1, name: "Account updates", description: "Original scoped tool fixture", category: "operations", taskset: learningRef(taskset), taskDefinition: learningRef(taskDefinition), rewardBinding: learningRef(binding), rewards: [learningRef(reward)], assets: assets.map(learningRef), previewTaskIds: ["account-task-0"], startingModel: { schemaVersion: "openpond.baseModelPreference.v1", modelId: "fixture", revision: null, tokenizerRevision: null, chatTemplateHash: null, modelAssetId: null, source: "managed" }, supportedMethods: ["sft"], defaultMethod: "sft", provenance: { author: "OpenPond", license: "MIT", sourceDescription: "Original test world" }, evidence: { verifierFixtures: null, baseline: null, training: null, evaluation: null } }));
  const resolved = validateResolvedModelStarter({ starter, taskset, taskDefinition, rewardBinding: binding, rewards: [reward], assets, execution: { environment, verifierSet, javascript } });
  const createdAt = "2026-09-07T05:00:00.000Z";
  const request = await createModelStarterCreationRequest({ profileId: "profile", modelId: "tool-model", name: starter.name, starter: learningRef(starter), startingModel: starter.startingModel, method: "sft" });
  const source = TasksetSourceRefSchema.parse({ schemaVersion: "openpond.generatedDatasetSource.v1", kind: "generated", id: "account-source", profileId: "profile", title: "Original tool fixture", sourceHash: starter.contentHash, occurredAt: createdAt, licensingStatus: "approved", secretScanStatus: "passed", piiScanStatus: "passed", generatorId: "account-fixture", generatorVersion: "1", generatorHash: taskset.contentHash, seed: 0, metadata: {} });
  const fixtureBase = { taskId: "account-task-0", output: { updated: true }, infrastructureError: null, expectedRewardEligible: true };
  return { request, package: resolved, source, createdAt, approvedTrainingTaskIds: ["account-task-0"], fixtures: [
    { ...fixtureBase, id: "writes-account", label: "positive" as const, expectedPassed: true, metadata: { toolScript: { actions: [{ name: "update_email", arguments: taskset.tasks[0]!.input }] } } },
    { ...fixtureBase, id: "claim-without-write", label: "adversarial" as const, expectedPassed: false, metadata: { toolScript: { actions: [] } } },
    { ...fixtureBase, id: "infrastructure-failure", label: "infrastructure_failure" as const, expectedPassed: false, expectedRewardEligible: false, infrastructureError: "Authored infrastructure failure fixture", metadata: {} },
  ] };
}
