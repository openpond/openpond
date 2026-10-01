import { expect, it } from "vitest";
import { contentHash, sha256 } from "@openpond/harness";
import { bindTasksetExecutionReleases, createEnvironmentRelease, createVerifierSetRelease } from "@openpond/evals";
import { TasksetReleaseSchema } from "@openpond/evals/tasksets";
import { createTasksetPackage, decodeTasksetPackageFile, validateTasksetPackage, OpenPondTasksetPackageClient, TasksetPackageModelConfigurationSchema, type TasksetPackagePublication } from "../src/taskset-packages.js";
import { HostedModelProjectTrainingSetupSchema } from "../src/model-projects.js";
import { prepareModelTasksetDraft, publishModelTasksetDraftPackage, ModelTasksetAuthoringSchema } from "../src/taskset-packages.js";
import { createLearningTextAsset, learningRef, sealLearningContent } from "@openpond/evals/learning";
import { compileBoundGraders, createRewardBinding, RewardBindingSchema, RewardReleaseSchema } from "@openpond/evals/rewards";
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

// A private independent Dataset read must verify the actor workspace and exact
// immutable release/package rather than accepting a valid but substituted graph.
it("retains private package closure and rejects substituted independent release readbacks", async () => {
  const value = fixture();
  const release = learningRef(value.taskset);
  let reply: unknown = { schemaVersion: "openpond.tasksetReleasePackageReadback.v1", teamId: "team-a", release, package: value };
  const requests: string[] = [];
  const client = new OpenPondTasksetPackageClient({ baseUrl: "https://example.test", apiKey: "fixture-token", teamId: "team-a",
    fetch: async (url, options) => {
      requests.push(String(url));
      expect(new Headers(options?.headers).get("X-OpenPond-Team-Id")).toBe("team-a");
      return Response.json(reply);
    },
  });
  expect(await client.getByRelease(release, { expectedPackageHash: value.contentHash })).toEqual(value);
  expect(requests[0]).toBe(`https://example.test/v1/taskset-packages/releases/${release.id}/${release.revision}/${release.contentHash}/package`);
  for (const substitution of [
    { teamId: "team-b" },
    { release: { ...release, revision: release.revision + 1 } },
    { release: { ...release, contentHash: "a".repeat(64) } },
  ]) {
    reply = { schemaVersion: "openpond.tasksetReleasePackageReadback.v1", teamId: "team-a", release, package: value, ...substitution };
    await expect(client.getByRelease(release)).rejects.toMatchObject({ code: "package_readback_mismatch" });
  }
  reply = { schemaVersion: "openpond.tasksetReleasePackageReadback.v1", teamId: "team-a", release, package: value };
  await expect(client.getByRelease(release, { expectedPackageHash: "b".repeat(64) })).rejects.toMatchObject({ code: "package_readback_mismatch" });
  const { contentHash: _hash, ...content } = value;
  const { contentHash: _taskHash, ...taskContent } = value.taskset;
  const altered = createTasksetPackage({ ...content, taskset: sealLearningContent({ ...taskContent, revision: value.taskset.revision + 1 }) });
  reply = { schemaVersion: "openpond.tasksetReleasePackageReadback.v1", teamId: "team-a", release, package: altered };
  await expect(client.getByRelease(release)).rejects.toMatchObject({ code: "package_readback_mismatch" });
});

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


// A metadata hash cannot authorize independent private calibration. Admission
// must retain the original executed fixture closure and keep it out of targets.
it("admits retained independent calibration and refuses substituted or exposed closure assets", async () => {
  const { compileRewardCheck, executeRewardFixture, matchRewardFixture, rewardAuthoringFields, AuthoringDraftSchema } = await import("@openpond/evals/learning");
  const { createRewardCalibrationClosure, verifyRewardCalibrationClosure, rewardCalibrationClosureAsset } = await import("@openpond/evals/learning/reward-calibration-closure");
  const { resolveTasksetCalibrationFixture } = await import("../src/taskset-calibration-fixtures.js");
  const at = "2026-10-01T00:00:00.000Z";
  const draft = AuthoringDraftSchema.parse(sealLearningContent({
    schemaVersion: "openpond.authoringDraft.v1", id: "calibration-draft", revision: 1, targetKind: "reward", targetId: "calibration-reward",
    editorVersion: "openpond.modelsEditor.v1", baseRelease: null, status: "draft", publishedRelease: null, createdAt: at, updatedAt: at,
    fields: { ...rewardAuthoringFields(null, null), name: "Retained state comparison", kind: "state", fields: "answer", fixtures: [
      { id: "positive", name: "Positive", input: JSON.stringify({ prompt: "Independent fixture request" }), output: JSON.stringify({ answer: "correct" }),
        expectedOutput: JSON.stringify({ answer: "correct" }), evaluatorContext: JSON.stringify({ privateCriterion: "retained grader only" }),
        artifactRefs: [], runtimeEventRefs: [], infrastructureError: "", expectedStatus: "scored", minimumScore: "1", maximumScore: "1", expectedPassed: "true" },
    ] },
  }));
  if (draft.targetKind !== "reward") throw new Error("Wrong fixture draft kind");
  const compiled = compileRewardCheck(draft, null);
  const independent = compiled.fixtures[0]!;
  const retained = matchRewardFixture(independent, await executeRewardFixture({ reward: compiled.reward, fixture: independent }));
  const check = { schemaVersion: "openpond.rewardCheckRun.v1" as const, id: "actual-check", revision: 2,
    draft: learningRef(draft), reward: learningRef(compiled.reward), snapshotHash: compiled.snapshotHash, fixtureRefs: compiled.fixtureRefs,
    status: "completed" as const, runtime: { id: "actual-deterministic-test-owner", packageVersion: "source", engine: "node" }, results: [retained], matchesExpectations: true, failure: null,
    timeoutMs: 1000, maximumSpendUsd: 0, leaseOwner: null, leaseExpiresAt: null, attemptCount: 1, createdAt: at, updatedAt: at };
  const closure = createRewardCalibrationClosure({ schemaVersion: "openpond.rewardCalibrationClosure.v1", reward: compiled.reward,
    draft, base: null, check, assets: compiled.assets });
  const privateAsset = rewardCalibrationClosureAsset(closure);
  const binding = createRewardBinding({ schemaVersion: "openpond.rewardBinding.v1", id: "calibration-binding", revision: 1,
    sources: [{ graderId: compiled.reward.id, reward: learningRef(compiled.reward), role: "evaluation", normalization: { kind: "identity" },
      weight: 1, required: true, hardGate: false, privileged: true, fixtureRefs: [] }], aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" }, [compiled.reward]);
  const original = fixture();
  const grader = compileBoundGraders(binding, [compiled.reward])[0]!;
  const { contentHash: _verifierHash, ...verifierBody } = original.verifierSet;
  const verifierSet = createVerifierSetRelease({ ...verifierBody, graders: [grader], calibrationReceiptRefs: [] });
  const id = `calibration-${contentHash([learningRef(compiled.reward), independent.id])}`;
  const authored = { id, taskId: id, label: "positive", output: independent.output, infrastructureError: null,
    expectedPassed: true, expectedRewardEligible: false, metadata: { rewardCalibration: {
      schemaVersion: "openpond.connectedRewardCalibrationProjection.v1", sourceReward: learningRef(compiled.reward), fixtureSet: compiled.reward.fixtureSetRef,
      calibrationCheck: { id: check.id, revision: check.revision, contentHash: contentHash(check) }, fixture: independent,
      fixtureHash: contentHash(independent), checkResultHash: contentHash(retained), independentCalibrationTask: true, closureRef: privateAsset.asset,
    } } };
  const { contentHash: _originalHash, ...originalTaskset } = original.taskset;
  const taskset = bindTasksetExecutionReleases({ taskset: sealLearningContent({ ...originalTaskset, graders: [grader],
    policy: { ...original.taskset.policy, hiddenGraderRefs: [grader.id] }, metadata: { ordinaryAuthoring: { graderFixtures: [authored] } } }),
    environment: original.environment, verifierSet });
  const files = [...original.files, ...compiled.assets, privateAsset].map(file => "base64" in file ? file
    : { asset: file.asset, base64: Buffer.from(file.text).toString("base64") });
  const value = createTasksetPackage({ schemaVersion: "openpond.tasksetPackage.v1", taskset, environment: original.environment, verifierSet, files });
  const resolved = resolveTasksetCalibrationFixture(value, id);
  expect(resolved.evaluatorContext).toEqual(independent.evaluatorContext);
  expect(resolved.task.expectedOutput).toEqual(independent.expectedOutput);
  expect(resolved.grader.rewardEligible).toBe(false);
  expect(value.taskset.tasks).toEqual(original.taskset.tasks);
  const { contentHash: _packageHash, ...packageBody } = value;
  const { contentHash: _tasksetHash, ...tasksetBody } = taskset;
  const reseal = (patch: Partial<typeof value>) => sealLearningContent({ ...packageBody, ...patch });
  expect(() => validateTasksetPackage(reseal({ files: files.filter(file => file.asset.id !== privateAsset.id) }))).toThrow(/calibration_closure_asset_changed/);
  expect(() => validateTasksetPackage(reseal({ files: [...files, { asset: { ...privateAsset.asset, id: "visible-alias", path: "shared/copied.json", visibility: "policy" }, base64: Buffer.from(privateAsset.text).toString("base64") }] }))).toThrow(/calibration_closure_visible_alias/);
  const { closureRef: _ref, ...unclosed } = authored.metadata.rewardCalibration;
  const unclosedTaskset = sealLearningContent({ ...tasksetBody, metadata: { ordinaryAuthoring: { graderFixtures: [{ ...authored, metadata: { rewardCalibration: unclosed } }] } } });
  const readableHistory = validateTasksetPackage(reseal({ taskset: unclosedTaskset, files: files.filter(file => file.asset.id !== privateAsset.id) }));
  expect(readableHistory.taskset.tasks).toEqual(original.taskset.tasks);
  expect(() => resolveTasksetCalibrationFixture(readableHistory, id)).toThrow();
  const { contentHash: _closureHash, ...closureBody } = closure;
  const changed = sealLearningContent({ ...closureBody, check: { ...check, results: [{ ...retained, result: { ...retained.result, rawScore: 0 } }] } });
  expect(() => verifyRewardCalibrationClosure(changed)).toThrow(/grader_evidence_hash_mismatch|bound_reward|reward_calibration_closure_fixture_mismatch/);
  const aliasedTaskset = sealLearningContent({ ...tasksetBody, tasks: taskset.tasks.map(task => ({ ...task, privilegedContextRef: privateAsset.id })) });
  expect(() => validateTasksetPackage(reseal({ taskset: aliasedTaskset }))).toThrow(/calibration_closure_task_alias/);
  const environmentAlias = sealLearningContent({ ...tasksetBody, metadata: { ...tasksetBody.metadata,
    environmentResources: [{ id: privateAsset.id, path: privateAsset.asset.path, visibility: "privileged" }] } });
  expect(() => validateTasksetPackage(reseal({ taskset: environmentAlias }))).toThrow(/calibration_closure_environment_resource_alias/);
});

// Connected publication remaps authored fixture IDs, but must retain the exact
// executable rubric/model and original private calibration authority.
it("retains qualified projected judge pins and refuses changed model, rubric or fixture membership", async () => {
  const learning = await import("@openpond/evals/learning");
  const { createRewardCalibrationClosure, rewardCalibrationClosureAsset } = await import("@openpond/evals/learning/reward-calibration-closure");
  const { projectLearningBatchGraders } = await import("../src/taskset-package-grader-projection.js");
  const { prepareImportedTasksetPackage } = await import("../src/taskset-package-projection.js");
  const { materializePortableTasksetRelease } = await import("../src/taskset-authored-portable-release.js");
  const { computeTasksetHash } = await import("../src/taskset-authored-validation.js");
  const { resolveTasksetCalibrationFixture } = await import("../src/taskset-calibration-fixtures.js");
  const at = "2026-10-01T00:00:00.000Z";
  const draft = learning.AuthoringDraftSchema.parse(sealLearningContent({
    schemaVersion: "openpond.authoringDraft.v1", id: "judge-draft", revision: 1, targetKind: "reward", targetId: "retained-judge",
    editorVersion: "openpond.modelsEditor.v1", baseRelease: null, status: "draft", publishedRelease: null, createdAt: at, updatedAt: at,
    fields: { ...learning.rewardAuthoringFields(null, null), name: "Pinned judge", kind: "model_judge", rubric: "Compare the retained criterion.",
      providerId: "openai", modelId: "source-test-judge", modelRevision: "pinned-v1", fixtures: [true, false].map(passed => ({
        id: passed ? "positive" : "negative", name: passed ? "Positive" : "Negative", input: "{}", output: JSON.stringify({ passed }),
        expectedOutput: "", evaluatorContext: JSON.stringify({ privateCriterion: "retained grader only" }), artifactRefs: [], runtimeEventRefs: [],
        infrastructureError: "", expectedStatus: "scored", minimumScore: passed ? "1" : "0", maximumScore: passed ? "1" : "0", expectedPassed: passed ? "true" : "false",
      })) },
  }));
  if (draft.targetKind !== "reward") throw new Error("Wrong fixture draft kind");
  const compiled = learning.compileRewardCheck(draft, null);
  let calls: import("@openpond/evals/learning").JudgeCallReservation[] = [];
  const results: ReturnType<typeof learning.matchRewardFixture>[] = [];
  for (const independent of compiled.fixtures) {
    const execute = learning.createBudgetedJudgeExecutor({ maximumCharge: () => 0.01,
      store: { async transaction(_intent, update) { const next = update({ maximumSpendUsd: 1, calls }); calls = next.calls; return next.result; } },
      async dispatch(request) { const passed = Boolean(JSON.parse(request.data).attempt.output.passed); return {
        text: JSON.stringify({ score: passed ? 1 : 0, passed, feedback: "Source boundary response" }), modelId: request.modelId,
        modelRevision: request.revision, responseId: `source-test-${independent.id}`, inputTokens: 5, outputTokens: 5, costUsd: 0,
      }; },
    });
    const modelJudge = learning.createBoundModelJudgeRunner({ readRubric: async () => draft.fields.rubric,
      executeBudgeted: (request, signal) => execute(`fixture-${contentHash([independent, compiled.reward.contentHash])}`, request, signal) });
    results.push(learning.matchRewardFixture(independent, await learning.executeRewardFixture({ reward: compiled.reward, fixture: independent, modelJudge })));
  }
  const check = learning.RewardCheckRunSchema.parse({ schemaVersion: "openpond.rewardCheckRun.v1", id: "judge-check", revision: 2,
    draft: learningRef(draft), reward: learningRef(compiled.reward), snapshotHash: compiled.snapshotHash, fixtureRefs: compiled.fixtureRefs,
    status: "completed", runtime: { id: "source-test-owner", packageVersion: "source", engine: "node" }, results, judgeCalls: calls,
    matchesExpectations: true, failure: null, timeoutMs: 1000, maximumSpendUsd: 1, leaseOwner: null, leaseExpiresAt: null,
    attemptCount: 1, createdAt: at, updatedAt: at });
  const reward = learning.qualifyRewardCheck(draft, null, check).reward;
  const closure = createRewardCalibrationClosure({ schemaVersion: "openpond.rewardCalibrationClosure.v1", reward, draft, base: null, check, assets: compiled.assets });
  const asset = rewardCalibrationClosureAsset(closure);
  const binding = createRewardBinding({ schemaVersion: "openpond.rewardBinding.v1", id: "judge-binding", revision: 1,
    sources: [{ graderId: reward.id, reward: learningRef(reward), role: "evaluation", normalization: { kind: "identity" },
      weight: 1, required: true, hardGate: false, privileged: true, fixtureRefs: [] }], aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" }, [reward]);
  const fixtures = compiled.fixtures.map((fixture, index) => { const id = `calibration-${contentHash([learningRef(reward), fixture.id])}`;
    return { id, taskId: id, label: fixture.expected.status === "scored" && fixture.expected.passed ? "positive" as const : "negative" as const,
      output: fixture.output, infrastructureError: null, expectedPassed: index === 0, expectedRewardEligible: false,
      metadata: { rewardCalibration: { schemaVersion: "openpond.connectedRewardCalibrationProjection.v1", sourceReward: learningRef(reward),
        fixtureSet: reward.fixtureSetRef, calibrationCheck: reward.calibrationCheckRef, fixture, fixtureHash: contentHash(fixture),
        checkResultHash: contentHash(results[index]), independentCalibrationTask: true, closureRef: asset.asset, graderId: reward.id } } }; });
  const projected = projectLearningBatchGraders(binding, [reward], compiled.assets)[0]!;
  if (projected.kind !== "model_judge") throw new Error("Wrong projected grader kind");
  const grader = { ...projected, calibrationFixtureRefs: fixtures.map(fixture => fixture.id), metadata: { ...projected.metadata,
    sourceCalibrationFixtureRefs: projected.calibrationFixtureRefs, sourceReward: learningRef(reward) } };
  const original = fixture();
  const imported = prepareImportedTasksetPackage({ package: original, profileId: "source-test", name: "Connected projection", createdAt: at }).taskset;
  const { derivedPortableMetadata: _sourceMetadata, ...metadata } = imported.metadata;
  const authored = { ...imported, graders: [grader], graderFixtures: fixtures, metadata,
    policy: { ...imported.policy, hiddenGraderRefs: [grader.id] }, environment: { ...imported.environment, metadata: {} } };
  const releases = materializePortableTasksetRelease({ taskset: { ...authored, contentHash: computeTasksetHash(authored) }, adapterId: "source-test" });
  const value = createTasksetPackage({ schemaVersion: "openpond.tasksetPackage.v1", taskset: releases.tasksetRelease,
    environment: releases.environmentRelease, verifierSet: releases.verifierSetRelease,
    files: [...original.files, ...compiled.assets, asset].map(file => "base64" in file ? file : { asset: file.asset, base64: Buffer.from(file.text).toString("base64") }) });
  expect(resolveTasksetCalibrationFixture(value, fixtures[0]!.id).grader).toMatchObject({ kind: "model_judge", model: { revision: "pinned-v1" } });
  const portable = value.taskset.graders[0]!;
  if (portable.kind !== "model_judge") throw new Error("Wrong portable grader kind");
  const { contentHash: _packageHash, ...body } = value;
  const { contentHash: _taskHash, ...taskBody } = value.taskset;
  for (const replacement of [{ ...portable, model: { ...portable.model!, modelId: "substituted" } },
    { ...portable, rubricRef: { ...portable.rubricRef, contentHash: "a".repeat(64) } }]) {
    const changed = sealLearningContent({ ...body, taskset: sealLearningContent({ ...taskBody, graders: [replacement] }) });
    expect(() => resolveTasksetCalibrationFixture(changed, fixtures[0]!.id)).toThrow(/calibration_grader_changed/);
  }
  const changed = sealLearningContent({ ...body, taskset: sealLearningContent({ ...taskBody, metadata: { ...taskBody.metadata,
    ordinaryAuthoring: { graderFixtures: fixtures, judgeCalibrationFixtures: { [grader.id]: [fixtures[0]!.id] } } } }) });
  expect(() => resolveTasksetCalibrationFixture(changed, fixtures[0]!.id)).toThrow(/calibration_judge_membership_changed/);
});
