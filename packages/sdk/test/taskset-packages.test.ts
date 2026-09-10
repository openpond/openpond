import { expect, it } from "vitest";
import { contentHash, sha256 } from "@openpond/harness";
import { bindTasksetExecutionReleases, createEnvironmentRelease, createVerifierSetRelease } from "@openpond/evals";
import { TasksetReleaseSchema } from "@openpond/evals/tasksets";
import { createTasksetPackage, decodeTasksetPackageFile, validateTasksetPackage, OpenPondTasksetPackageClient, TasksetPackageModelConfigurationSchema, type TasksetPackagePublication } from "../src/taskset-packages.js";
import { HostedModelProjectTrainingSetupSchema } from "../src/model-projects.js";
import { prepareModelTasksetDraft, publishModelTasksetDraftPackage, ModelTasksetAuthoringSchema } from "../src/taskset-packages.js";
import { createLearningTextAsset, learningRef, sealLearningContent } from "@openpond/evals/learning";
import { RewardBindingSchema, RewardReleaseSchema } from "@openpond/evals/rewards";
import { bindOrdinaryModelTasksetReward } from "../src/taskset-packages.js";
import { deriveModelTaskset } from "../src/model-taskset-derivation.js";
import { createJavaScriptEnvironmentSession } from "@openpond/evals/javascript-environment";
import { executeJavaScriptEnvironmentInWorker } from "@openpond/evals/javascript-environment/node";
import { resolveTasksetPackageExecution } from "../src/taskset-packages.js";
import { ordinaryToolTaskset } from "./fixtures/ordinary-tool-taskset.js";

// Ordinary executable packages must close their private graph at admission,
// and owned revisions must execute changed code without altering the source.
it("validates and reseals ordinary JavaScript execution across owned revisions", async () => {
  const source = ordinaryToolTaskset();
  const owner = { scopeId: "local", modelId: "ordinary-model" };
  const prepared = prepareModelTasksetDraft({ owner, source, request: { schemaVersion: "openpond.modelTasksetDraftRequest.v1", operationId: "edit-world", modelId: owner.modelId, expectedModelRevision: 1, sourcePackageHash: source.contentHash } });
  const published = publishModelTasksetDraftPackage({ preparation: prepared, edited: ordinaryToolTaskset(2) });
  expect(resolveTasksetPackageExecution(published)?.execution.verifierSet).toEqual(published.verifierSet);
  async function inspect(value: typeof source) {
    const resolved = resolveTasksetPackageExecution(value)!;
    const session = await createJavaScriptEnvironmentSession({ definition: resolved.execution.javascript,
      asset: resolved.assets.find(asset => asset.id === resolved.execution.javascript.module.id)!,
      initialState: JSON.parse(resolved.assets.find(asset => asset.id === value.taskset.tasks[0]!.privilegedContextRef)!.text),
      input: value.taskset.tasks[0]!.input, seed: 17, execute: executeJavaScriptEnvironmentInWorker,
    });
    try { return await session.step({ name: "inspect", arguments: {} }); }
    finally { await session.destroy(); }
  }
  expect(await inspect(source)).toEqual({ value: 1 });
  expect(await inspect(published)).toEqual({ value: 2 });
  expect(await inspect(source)).toEqual({ value: 1 });
  const { contentHash: _hash, ...content } = source;
  for (const file of source.files) expect(() => createTasksetPackage({ ...content, files: source.files.filter(candidate => candidate !== file) })).toThrow(/missing/);
  const module = resolveTasksetPackageExecution(source)!.execution.javascript.module;
  expect(() => createTasksetPackage({ ...content, files: source.files.map(file => file.asset.id === module.id ? { ...file, asset: { ...file.asset, visibility: "policy" } } : file) })).toThrow();
});

function fixture() {
  const file = (id: string, bytes: Uint8Array, visibility: "policy" | "host_private" | "verifier") => ({
    asset: { id, path: `assets/${id}`, mediaType: "application/octet-stream", sizeBytes: bytes.byteLength, contentHash: sha256(bytes), visibility },
    base64: Buffer.from(bytes).toString("base64"),
  });
  const files = [file("binary-input", new Uint8Array([0, 255, 128, 13, 10]), "policy"), file("private-context", new TextEncoder().encode("private expected state"), "host_private"), file("verifier", new TextEncoder().encode("export function verify() { return { score: 1, passed: true }; }"), "verifier"), file("schema", new TextEncoder().encode("{}"), "verifier"), file("metric", new TextEncoder().encode("export function aggregate(scores) { return Math.min(...scores); }"), "host_private")];
  const environment = createEnvironmentRelease({
    schemaVersion: "openpond.environmentRelease.v1", id: "work-environment", revision: 1,
    contract: { protocolVersion: "openpond.environment.v1", kind: "work", entrypoint: "work", stateful: true, deterministicSeeds: true, lifecycle: ["create", "reset", "step", "collect", "destroy"], networkPolicy: "none", defaultTimeoutMs: 10_000 },
    actionSchemaRef: files[3]!.asset, observationSchemaRef: null, stateSchemaRef: null,
    artifactCollection: { maxArtifacts: 10, maxTotalBytes: 100_000 }, adapterConformanceHashes: {}, metadata: {},
  });
  const verifierSet = createVerifierSetRelease({
    schemaVersion: "openpond.verifierSetRelease.v1", id: "work-verifiers", revision: 1,
    graders: [{ id: "verify", version: "1", kind: "custom_verifier", weight: 1, hardGate: true, rewardEligible: true, privileged: true, verifierRef: files[2]!.asset, timeoutMs: 1_000, networkPolicy: "none" }],
    isolation: { processBoundary: "isolated_process", networkPolicy: "none", defaultTimeoutMs: 1_000 }, calibrationReceiptRefs: [], metadata: {},
  });
  const content = {
    schemaVersion: "openpond.tasksetRelease.v2", id: "work-tasks", revision: 1,
    policy: { policyVisibleFields: ["input"], privilegedFields: ["expectedOutput"], hiddenGraderRefs: ["verify"], connectedAppScopes: [] },
    environment: environment.contract, tools: [], capabilities: [], graders: verifierSet.graders,
    metrics: { schemaVersion: "openpond.tasksetMetricPolicy.v1", primaryMetric: "quality", aggregation: "custom", missingReward: "zero", customAggregator: { module: files[4]!.asset.path, exportName: "aggregate", contentHash: files[4]!.asset.contentHash, timeoutMs: 1_000, networkPolicy: "none" } },
    tasks: [{ id: "task", clusterKey: "family", split: "train", input: { prompt: "Read input" }, expectedOutput: null, policyVisibleContext: {}, privilegedContextRef: "private-context", artifactRefs: [files[0]!.asset], requiredOutputs: [{ path: "output.json", mediaType: "application/json", schemaRef: files[3]!.asset, maxBytes: 1_000, metadata: {} }], tags: [] }], metadata: {},
  };
  const taskset = bindTasksetExecutionReleases({ taskset: TasksetReleaseSchema.parse({ ...content, contentHash: contentHash(content) }), environment, verifierSet });
  return createTasksetPackage({ schemaVersion: "openpond.tasksetPackage.v1", taskset, environment, verifierSet, files });
}

// Selecting a reusable Reward must not rewrite requests, lose binary/private
// assets, mutate shared history, or claim the old checker's qualification.
it("binds ordinary packages while retaining exact task and execution data", () => {
  const asset = createLearningTextAsset({ path: "graders/selected.js", mediaType: "application/javascript", visibility: "verifier", text: "export function verify() { return { score: 1, passed: true }; }" });
  const reward = RewardReleaseSchema.parse(sealLearningContent({ schemaVersion: "openpond.rewardRelease.v1", id: "selected-reward", revision: 1, name: "Selected", description: "", implementation: { kind: "custom_verifier", verifierRef: asset.asset, exportName: "verify", timeoutMs: 1_000, networkPolicy: "none" }, rawScore: { minimum: 0, maximum: 1 }, assets: [asset.asset] }));
  const rewardBinding = RewardBindingSchema.parse(sealLearningContent({ schemaVersion: "openpond.rewardBinding.v1", id: "selected-binding", revision: 1, name: "Selected", description: "", sources: [{ graderId: "selected", reward: learningRef(reward), role: "training", normalization: { kind: "identity" }, weight: 1, required: true, hardGate: true, privileged: true, fixtureRefs: [] }], aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" }));
  const owner = { scopeId: "profile-a", modelId: "model-a" };
  for (const original of [fixture(), ordinaryToolTaskset()]) {
    const { contentHash: _packageHash, ...packageContent } = original;
    const { contentHash: _taskHash, ...taskContent } = original.taskset;
    const source = createTasksetPackage({ ...packageContent, taskset: sealLearningContent({ ...taskContent,
      metadata: { ...taskContent.metadata, ordinaryAuthoring: { instructions: "Follow each task request." }, qualification: { passed: true } },
    }) });
    const before = JSON.stringify(source);
    const intent = { owner, source, rewardBinding, rewards: [reward], assets: [asset] };
    const bound = bindOrdinaryModelTasksetReward(intent);
    expect(bound).toEqual(bindOrdinaryModelTasksetReward(intent));
    expect(bound.taskset.tasks).toEqual(source.taskset.tasks);
    expect(bound.taskset.tools).toEqual(source.taskset.tools);
    expect(bound.taskset.metrics).toEqual(source.taskset.metrics);
    expect(bound.environment).toEqual(source.environment);
    for (const file of source.files) expect(bound.files).toContainEqual(file);
    expect(bound.modelResources?.instructionMode).toBe("per_task");
    expect(bound.taskset.metadata.modelTasksetDerivation).toMatchObject({ owner, root: learningRef(source.taskset), parent: learningRef(source.taskset) });
    expect(bound.taskset.metadata).not.toHaveProperty("qualification");
    expect(bound.verifierSet.calibrationReceiptRefs).toEqual([]);
    expect(bound.taskset.graders[0]?.id).toBe("selected");
    const next = deriveModelTaskset({ ...intent, assets: bound.modelResources!.assets, source: { ...bound.modelResources!, taskset: bound.taskset, executionResources: { environment: bound.environment, verifierSet: bound.verifierSet } } });
    expect(next.taskset.id).toBe(bound.taskset.id);
    expect(next.taskset.revision).toBe(2);
    expect(next.taskset.tasks).toEqual(source.taskset.tasks);
    expect(bindOrdinaryModelTasksetReward({ ...intent, owner: { ...owner, modelId: "model-b" } }).taskset.id).not.toBe(bound.taskset.id);
    expect(() => bindOrdinaryModelTasksetReward({ ...intent, assets: [] })).toThrow(/private asset/);
    expect(() => bindOrdinaryModelTasksetReward({ ...intent, source: bound })).toThrow(/ordinary source/);
    expect(JSON.stringify(source)).toBe(before);
  }
});

// Editing an ordinary shared package must fork only the intended Model while
// retaining exact binary/private dependencies and immutable source history.
it("prepares repeatable owned drafts and seals isolated ordinary revisions", () => {
  const source = fixture();
  const original = JSON.stringify(source);
  const owner = { scopeId: "profile-a", modelId: "model-a" };
  const request = { schemaVersion: "openpond.modelTasksetDraftRequest.v1" as const, operationId: "edit-one", modelId: owner.modelId,
    expectedModelRevision: 1, sourcePackageHash: source.contentHash };
  const prepared = prepareModelTasksetDraft({ owner, source, request });
  expect(prepareModelTasksetDraft({ owner, source, request })).toEqual(prepared);
  expect(() => prepareModelTasksetDraft({ owner, source, request: { ...request, sourcePackageHash: "a".repeat(64) } })).toThrow("source package changed");
  const code = new TextEncoder().encode("export function verify() { return { score: 0, passed: false }; }");
  const changedFile = { ...source.files[2]!, asset: { ...source.files[2]!.asset, contentHash: sha256(code), sizeBytes: code.byteLength }, base64: Buffer.from(code).toString("base64") };
  const { contentHash: _oldVerifierHash, ...oldVerifier } = source.verifierSet;
  const changedVerifier = createVerifierSetRelease({ ...oldVerifier, revision: 2,
    graders: oldVerifier.graders.map(grader => grader.kind === "custom_verifier" ? { ...grader, verifierRef: changedFile.asset } : grader),
    calibrationReceiptRefs: [{ id: "old-calibration", contentHash: "c".repeat(64) }],
  });
  const { contentHash: _hash, ...sourceContent } = source.taskset;
  const changedContent = { ...sourceContent, graders: changedVerifier.graders, verifierSetRelease: { id: changedVerifier.id, contentHash: changedVerifier.contentHash },
    tasks: source.taskset.tasks.map(task => ({ ...task, input: { prompt: "Read the revised input" } })),
    metadata: { qualification: { passed: true }, privacyReview: { approved: true }, ordinaryAuthoring: { graderFixtures: [] } } };
  const { contentHash: _packageHash, ...packageContent } = source;
  const edited = createTasksetPackage({ ...packageContent, verifierSet: changedVerifier, files: source.files.map((file, index) => index === 2 ? changedFile : file),
    taskset: TasksetReleaseSchema.parse({ ...changedContent, contentHash: contentHash(changedContent) }) });
  const published = publishModelTasksetDraftPackage({ preparation: prepared, edited });
  expect(published.taskset.id).not.toBe(source.taskset.id);
  expect(published.taskset.revision).toBe(1);
  expect(published.taskset.tasks[0]!.input).toEqual({ prompt: "Read the revised input" });
  expect(published.files).toEqual(edited.files);
  expect(decodeTasksetPackageFile(published.files[2]!)).toEqual(code);
  expect(published.files.filter((_, index) => index !== 2)).toEqual(source.files.filter((_, index) => index !== 2));
  expect(published.environment).toEqual(source.environment);
  expect(published.taskset.metrics).toEqual(source.taskset.metrics);
  expect(published.taskset.metadata).not.toHaveProperty("qualification");
  expect(published.taskset.metadata).not.toHaveProperty("privacyReview");
  expect(published.verifierSet.calibrationReceiptRefs).toEqual([]);
  expect(ModelTasksetAuthoringSchema.parse(published.taskset.metadata.modelTasksetAuthoring)).toMatchObject({ owner, root: learningRef(source.taskset), parent: learningRef(source.taskset) });
  const second = prepareModelTasksetDraft({ owner, source: published, request: { ...request, operationId: "edit-two", expectedModelRevision: 2, sourcePackageHash: published.contentHash } });
  const next = publishModelTasksetDraftPackage({ preparation: second, edited: published });
  expect(next.taskset.id).toBe(published.taskset.id);
  expect(next.taskset.revision).toBe(2);
  expect(next.files).toEqual(edited.files);
  const foreign = prepareModelTasksetDraft({ owner: { ...owner, scopeId: "another-profile" }, source: published,
    request: { ...request, sourcePackageHash: published.contentHash } });
  expect(foreign.tasksetId).not.toBe(published.taskset.id);
  expect(foreign.tasksetRevision).toBe(1);
  expect(() => publishModelTasksetDraftPackage({ preparation: { ...second, sourceTasksetRef: learningRef(source.taskset) }, edited: published })).toThrow("source lineage");
  expect(() => publishModelTasksetDraftPackage({ preparation: { ...second, tasksetId: source.taskset.id }, edited: published })).toThrow("ownership lineage");
  expect(JSON.stringify(source)).toBe(original);
  expect(validateTasksetPackage(published)).toEqual(published);
});

// A metadata-only transfer must not appear complete while Work inputs or
// evaluator dependencies are missing, substituted, or disclosed to the policy.
it("round-trips binary Work packages and enforces their complete private dependency graph", () => {
  const original = fixture();
  expect(validateTasksetPackage(JSON.parse(JSON.stringify(original)))).toEqual(original);
  expect(decodeTasksetPackageFile(original.files[0]!)).toEqual(new Uint8Array([0, 255, 128, 13, 10]));
  for (const file of original.files) {
    const { contentHash: _hash, ...content } = original;
    expect(() => createTasksetPackage({ ...content, files: content.files.filter(value => value.asset.id !== file.asset.id) })).toThrow(/missing/);
  }
  const { contentHash: _hash, ...content } = original;
  expect(() => createTasksetPackage({ ...content, files: [...content.files, content.files[0]!] })).toThrow("Duplicate");
  expect(() => createTasksetPackage({ ...content, files: content.files.map((file, index) => index === 0 ? { ...file, base64: Buffer.from("tampered").toString("base64") } : file) })).toThrow("immutable bytes");
  expect(() => createTasksetPackage({ ...content, files: content.files.map(file => file.asset.id === "private-context" ? { ...file, asset: { ...file.asset, visibility: "policy" } } : file) })).toThrow("private context");
  expect(() => createTasksetPackage({ ...content, files: content.files.map(file => file.asset.id === "metric" ? { ...file, asset: { ...file.asset, visibility: "policy" } } : file) })).toThrow("metric module");
  expect(() => createTasksetPackage({ ...content, environment: { ...content.environment, revision: 2 } })).toThrow("execution releases");
  expect(() => validateTasksetPackage({ ...original, contentHash: "0".repeat(64) })).toThrow("content hash");
});

// A transfer response from a different workspace or release must never become
// a local package or a successful publication receipt, even if it is valid JSON.
it("binds upload receipts and downloaded packages to the requested owner and release", async () => {
  const packageValue = fixture();
  const ref = { id: packageValue.taskset.id, revision: packageValue.taskset.revision, contentHash: packageValue.taskset.contentHash };
  const requests: { url: string; body: string | undefined; team: string | null; redirect: RequestRedirect | undefined }[] = [];
  let wrongOwner = false;
  const client = new OpenPondTasksetPackageClient({ baseUrl: "https://api.example.test", apiKey: "test-key", teamId: "team-a", fetch: async (url, options) => {
    requests.push({ url: String(url), body: options?.body as string | undefined, team: new Headers(options?.headers).get("X-OpenPond-Team-Id"), redirect: options?.redirect });
    const owner = { teamId: wrongOwner ? "team-b" : "team-a", modelProjectId: "model-a" };
    return Response.json(options?.method === "POST" ? { schemaVersion: "openpond.tasksetPackageReceipt.v1", ...owner, operationId: "publication-a", taskset: ref, packageHash: packageValue.contentHash, hostedTasksetId: "hosted-taskset", projectEtag: "a".repeat(64) } : { schemaVersion: "openpond.tasksetPackageReadback.v1", ...owner, package: packageValue });
  } });
  const publication: TasksetPackagePublication = { schemaVersion: "openpond.tasksetPackagePublication.v1", operationId: "publication-a", modelProjectId: "model-a", expectedProjectEtag: null, name: "Work tasks", description: "", buildIntent: "verifiable_reward", methodHint: null, package: packageValue };
  expect((await client.publish(publication)).packageHash).toBe(packageValue.contentHash);
  await client.publish(publication);
  expect(requests[0]!.body).toBe(requests[1]!.body);
  expect(await client.get("model-a", ref)).toEqual(packageValue);
  expect(requests.every(request => request.team === "team-a" && request.redirect === "error")).toBe(true);
  expect(requests[2]!.url).toBe(`https://api.example.test/v1/taskset-packages/model-a/${ref.id}/${ref.revision}/${ref.contentHash}`);
  wrongOwner = true;
  await expect(client.publish(publication)).rejects.toMatchObject({ code: "package_receipt_mismatch" });
  await expect(client.get("model-a", ref)).rejects.toMatchObject({ code: "package_readback_mismatch" });
  wrongOwner = false;
  await expect(client.get("model-a", { ...ref, revision: 2 })).rejects.toMatchObject({ code: "package_readback_mismatch" });
  expect(await client.get("model-a", ref, { expectedPackageHash: packageValue.contentHash })).toEqual(packageValue);
  await expect(client.get("model-a", ref, { expectedPackageHash: "0".repeat(64) })).rejects.toMatchObject({ code: "package_readback_mismatch" });
  const count = requests.length;
  await expect(client.get("model-a", ref, { expectedPackageHash: "invalid" })).rejects.toThrow();
  expect(requests).toHaveLength(count);
});

// A successful package upload must not mask a lost Model rename/configuration
// or accept a receipt for another Model when both are saved atomically.
it("requires the exact Model configuration in an atomic publication receipt", async () => {
  const packageValue = fixture();
  const taskset = { id: packageValue.taskset.id, revision: packageValue.taskset.revision, contentHash: packageValue.taskset.contentHash };
  const modelConfiguration = TasksetPackageModelConfigurationSchema.parse({ portableProjectId: "portable-model", name: "Updated Model", objective: "Preserve my setup", defaultBaseModel: null, defaultDestinationId: null, trainingSetup: {}, sourceRevision: 1, sourceUpdatedAt: "2026-09-07T00:00:00Z" });
  const project = { ...modelConfiguration, id: "hosted-model", teamId: "team-a", revision: 1, sourceRevision: 1, etag: "a".repeat(64), createdAt: "2026-09-07T00:00:00Z", updatedAt: "2026-09-07T00:00:00Z", sourceUpdatedAt: "2026-09-07T00:00:00Z",
    trainingSetup: HostedModelProjectTrainingSetupSchema.parse({ ...modelConfiguration.trainingSetup, tasksetRef: taskset, rewardBindingRef: null, tasksetRelease: null, recipe: null }) };
  let result: unknown = project;
  const client = new OpenPondTasksetPackageClient({ baseUrl: "https://api.example.test", apiKey: "key", teamId: "team-a", fetch: async () => Response.json({ schemaVersion: "openpond.tasksetPackageReceipt.v1", teamId: "team-a", modelProjectId: "portable-model", operationId: "atomic-create", taskset, packageHash: packageValue.contentHash, hostedTasksetId: "hosted-taskset", projectEtag: project.etag, ...(result ? { project: result } : {}) }) });
  const publication: TasksetPackagePublication = { schemaVersion: "openpond.tasksetPackagePublication.v1", modelProjectId: "portable-model", operationId: "atomic-create", expectedProjectEtag: null, name: "Work", description: "", buildIntent: "discovery", methodHint: null, package: packageValue, modelConfiguration };
  expect((await client.publish(publication)).project?.name).toBe("Updated Model");
  for (const invalid of [undefined, { ...project, name: "Lost rename" }, { ...project, portableProjectId: "other-model" }, { ...project, trainingSetup: HostedModelProjectTrainingSetupSchema.parse({}) }]) {
    result = invalid;
    await expect(client.publish(publication)).rejects.toMatchObject({ code: "package_receipt_mismatch" });
  }
});

// A Model must not report its evaluation as synchronized when only training
// bytes were stored, or when the receipt identifies a different evaluation.
it("binds the complete evaluation package to the selected reference and receipt", async () => {
  const value = fixture();
  const ref = learningRef(value.taskset);
  const modelConfiguration = TasksetPackageModelConfigurationSchema.parse({ portableProjectId: "model-a", name: "Model", objective: null, defaultBaseModel: null, defaultDestinationId: null, trainingSetup: { evaluationTasksetRef: ref, recipe: { schemaVersion: "openpond.rftRecipe.v1", method: "grpo", parameterization: "lora", resourceLimits: { maxGpuSeconds: 1200 } } }, sourceRevision: 1, sourceUpdatedAt: "2026-09-09T00:00:00Z" });
  const project = { ...modelConfiguration, id: "hosted-model", teamId: "team-a", revision: 1, etag: "a".repeat(64), createdAt: modelConfiguration.sourceUpdatedAt, updatedAt: modelConfiguration.sourceUpdatedAt,
    trainingSetup: HostedModelProjectTrainingSetupSchema.parse({ ...modelConfiguration.trainingSetup, tasksetRef: ref, rewardBindingRef: null }) };
  const expected = { taskset: ref, packageHash: value.contentHash, hostedTasksetId: "hosted-evaluation" };
  let evaluation: unknown = expected;
  let returnedProject: unknown = project;
  let requests = 0;
  const client = new OpenPondTasksetPackageClient({ baseUrl: "https://api.example.test", apiKey: "key", teamId: "team-a", fetch: async () => {
    requests++;
    return Response.json({ schemaVersion: "openpond.tasksetPackageReceipt.v1", teamId: "team-a", modelProjectId: "model-a", operationId: "evaluation-create", taskset: ref, packageHash: value.contentHash, hostedTasksetId: "hosted-training", projectEtag: project.etag, project: returnedProject, evaluation });
  } });
  const publication: TasksetPackagePublication = { schemaVersion: "openpond.tasksetPackagePublication.v1", operationId: "evaluation-create", modelProjectId: "model-a", expectedProjectEtag: null, name: "Training", description: "", buildIntent: "discovery", methodHint: null, package: value, evaluationPackage: value, modelConfiguration };
  expect((await client.publish(publication)).evaluation).toEqual(expected);
  for (const invalid of [undefined, { ...expected, packageHash: "b".repeat(64) }, { ...expected, taskset: { ...ref, id: "another-evaluation" } }]) {
    evaluation = invalid;
    await expect(client.publish(publication)).rejects.toMatchObject({ code: "package_receipt_mismatch" });
  }
  evaluation = expected;
  returnedProject = { ...project, trainingSetup: { ...project.trainingSetup, recipe: null } };
  await expect(client.publish(publication)).rejects.toMatchObject({ code: "package_receipt_mismatch" });
  const before = requests;
  await expect(client.publish({ ...publication, modelConfiguration: { ...modelConfiguration, trainingSetup: { ...modelConfiguration.trainingSetup, evaluationTasksetRef: { ...ref, contentHash: "c".repeat(64) } } } })).rejects.toThrow();
  await expect(client.publish({ ...publication, modelConfiguration: undefined })).rejects.toThrow();
  expect(requests).toBe(before);
});
