import { expect, it } from "vitest";
import { genericToolConformance } from "@openpond/evals/conformance";
import { createAttemptReceipt } from "@openpond/evals/runs";
import { aggregateTasksetRunReceipts, createTasksetRunManifest, tasksetRunMetricPolicy } from "@openpond/evals/metrics";
import { ModelTasksetRunRequestSchema, ModelTasksetRunSummarySchema, OpenPondModelTasksetRunsClient, type ModelTasksetRunDetails } from "../src/model-taskset-runs.js";
import { canonicalSha256 } from "../src/protocol.js";
import { contentHash } from "@openpond/harness";
import { OpenPondExperimentsClient, experimentDefinitionRef, verifyExperimentDefinition } from "../src/experiments.js";

const seal = async <T extends object>(content: T) => ({ ...content, contentHash: await canonicalSha256(content) });

// Published clients must not turn another workspace's run, a changed request,
// dropped failed member or training-role score into a valid evaluation result.
it("binds SDK transport and terminal results to the exact scoped evaluation population", async () => {
  const { taskset, manifest: legacy } = genericToolConformance;
  const request = ModelTasksetRunRequestSchema.parse({
    schemaVersion: "openpond.modelTasksetRunRequest.v1", operationId: "op", teamId: "team", modelProjectId: "model", name: "Response quality",
    taskset: { id: taskset.id, revision: 1, contentHash: taskset.contentHash }, policy: { kind: "fixture" },
    population: ["correct", "wrong", "infra"].map(receiptId => ({ receiptId, taskId: taskset.tasks[0]!.id, seed: "0", fixtureId: receiptId })),
  });
  const manifest = createTasksetRunManifest({
    schemaVersion: "openpond.tasksetRunManifest.v1", id: "run", tasksetRelease: legacy.tasksetRelease,
    packageHash: await canonicalSha256("package"), execution: { kind: "harness", harnessRelease: legacy.harnessRelease },
    policy: { kind: "fixture" }, gradingRole: "evaluation", metricPolicy: tasksetRunMetricPolicy(taskset), population: request.population,
    runtimeTarget: { ...legacy.runtimeTarget, placement: "remote" }, limits: legacy.limits, createdAt: legacy.createdAt, metadata: {},
  });
  const summary = ModelTasksetRunSummarySchema.parse({
    schemaVersion: "openpond.modelTasksetRunSummary.v1", id: manifest.id, revision: 1, teamId: request.teamId, modelProjectId: request.modelProjectId,
    operationId: request.operationId, name: request.name, taskset: request.taskset, policyKind: "fixture", manifestHash: manifest.contentHash,
    status: "queued", totalCount: 3, counts: { pending: 3, running: 0, completed: 0, failed: 0, cancelled: 0 },
    createdAt: manifest.createdAt, startedAt: null, completedAt: null, cleanupComplete: false, resultAvailable: false,
    score: null, metricName: manifest.metricPolicy.primaryMetric, error: null,
  });
  const details: ModelTasksetRunDetails = { summary, request, manifest, policySnapshot: null };
  let returned: unknown = details;
  const paths: string[] = [];
  const client = new OpenPondModelTasksetRunsClient({ baseUrl: "https://host.invalid", apiKey: "test", teamId: "team", fetch: async (url, init) => {
    paths.push(String(url));
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test", "X-OpenPond-Team-Id": "team" });
    return Response.json(returned);
  } });
  expect(await client.create(request)).toEqual(details);
  expect(await client.get("run")).toEqual(details);
  expect(await client.cancel("run")).toEqual(details);
  expect(paths).toEqual(["https://host.invalid/v1/model-taskset-runs", "https://host.invalid/v1/model-taskset-runs/run", "https://host.invalid/v1/model-taskset-runs/run/cancel"]);
  returned = { ...details, request: { ...request, teamId: "other" }, summary: { ...summary, teamId: "other" } };
  await expect(client.get("run")).rejects.toThrow("another identity or workspace");
  returned = { ...details, request: { ...request, population: request.population.slice(1) } };
  await expect(client.create(request)).rejects.toThrow("admitted request");
  returned = { ...details, summary: { ...summary, name: "Different experiment" } };
  await expect(client.get("run")).rejects.toThrow("admitted request");
  returned = { items: [{ ...summary, modelProjectId: "other" }], nextCursor: null };
  await expect(client.list({ modelProjectId: "model" })).rejects.toThrow("selected scope");
  expect(ModelTasksetRunRequestSchema.safeParse({ ...request, population: [{ ...request.population[0], seed: "01" }] }).success).toBe(false);
  expect(ModelTasksetRunRequestSchema.safeParse({ ...request, worldState: { score: 1 } }).success).toBe(false);
  const receipts = await Promise.all(request.population.map(async (member, index) => createAttemptReceipt({
    schemaVersion: "openpond.attemptReceipt.v1", id: member.receiptId, taskId: member.taskId, seed: member.seed,
    runManifest: { id: manifest.id, contentHash: manifest.contentHash }, terminal: true, failureClass: index === 2 ? "infrastructure_failure" : null,
    outputHash: null, traceHash: await canonicalSha256(member), artifactRefs: [], graderEvidenceRefs: [],
    startedAt: manifest.createdAt, completedAt: manifest.createdAt, latencyMs: 0, costUsd: null,
    metadata: { gradingRole: "evaluation", score: index === 0 ? 1 : index === 1 ? 0 : null, rewardEligible: index !== 2, passed: index === 0 },
  })));
  const metric = await aggregateTasksetRunReceipts({ manifest, taskset, receipts });
  const content = {
    schemaVersion: "openpond.modelTasksetRunResult.v1",
    run: { ...details, summary: { ...summary, revision: 2, status: "completed", completedAt: manifest.createdAt, cleanupComplete: true, resultAvailable: true, counts: { pending: 0, running: 0, completed: 2, failed: 1, cancelled: 0 }, score: metric.value } },
    receipts, metric,
  };
  returned = await seal(content);
  expect((await client.result("run")).metric?.value).toBe(0.5);
  returned = await seal({ ...content, receipts: receipts.slice(0, 2) });
  await expect(client.result("run")).rejects.toThrow("complete admitted population");
  const { contentHash: _receiptHash, ...receiptContent } = receipts[0]!;
  returned = await seal({ ...content, receipts: [createAttemptReceipt({ ...receiptContent, metadata: { ...receiptContent.metadata, gradingRole: "training" } }), ...receipts.slice(1)] });
  await expect(client.result("run")).rejects.toThrow("evaluation-role");
  returned = await seal({ ...content, metric: { ...metric, value: 1 } });
  await expect(client.result("run")).rejects.toThrow();
  returned = await seal({ ...content, run: { ...content.run, summary: { ...content.run.summary, status: "cancelled", score: null } } });
  await expect(client.result("run")).rejects.toThrow("Only completed");
  expect(ModelTasksetRunSummarySchema.safeParse({ ...content.run.summary, status: "cancelled", score: null, cleanupComplete: false }).success).toBe(false);
  const modelRequest = ModelTasksetRunRequestSchema.parse({ ...request, policy: { kind: "hosted_chat", modelId: "catalog-model" }, population: request.population.map(member => ({ ...member, fixtureId: null })) });
  const snapshot = { modelId: "catalog-model", provider: "test-provider", upstreamModelId: "upstream-model", configurationHash: await canonicalSha256("provider-config") };
  const { contentHash: _manifestHash, ...manifestContent } = manifest;
  const modelManifest = createTasksetRunManifest({ ...manifestContent, population: modelRequest.population, policy: { kind: "model", model: { provider: snapshot.provider, model: snapshot.upstreamModelId, revision: null, artifactHash: null, tokenizerRevision: null, chatTemplateHash: null }, configurationHash: await canonicalSha256({ policy: modelRequest.policy, snapshot }) } });
  const modelDetails = { ...details, request: modelRequest, policySnapshot: snapshot, manifest: modelManifest, summary: { ...summary, policyKind: "hosted_chat", manifestHash: modelManifest.contentHash } };
  returned = modelDetails;
  expect((await client.create(modelRequest)).manifest.policy.kind).toBe("model");
  // The Project is execution provenance, not a fabricated model configuration.
  // A server must not drop or substitute it while returning otherwise valid results.
  const project = { id: "project", revision: 2, contentHash: await canonicalSha256("project-revision"), targetId: "target" };
  const independentRequest = ModelTasksetRunRequestSchema.parse({ ...modelRequest, modelProjectId: null, project, policy: { ...modelRequest.policy, messages: [{ role: "system", content: "Answer accurately." }] } });
  if (modelManifest.policy.kind !== "model") throw new Error("Expected a model policy");
  const independentManifest = createTasksetRunManifest({ ...manifestContent, population: independentRequest.population, metadata: { project }, policy: { ...modelManifest.policy, configurationHash: await canonicalSha256({ policy: independentRequest.policy, snapshot }) } });
  const independentDetails = { ...modelDetails, request: independentRequest, manifest: independentManifest, summary: { ...modelDetails.summary, modelProjectId: null, project, manifestHash: independentManifest.contentHash } };
  returned = independentDetails;
  expect((await client.create(independentRequest)).summary.project).toEqual(project);
  returned = { ...independentDetails, summary: { ...independentDetails.summary, project: { ...project, revision: 3 } } };
  await expect(client.get("run")).rejects.toThrow("admitted request");
  returned = { ...independentDetails, request: { ...independentRequest, policy: { ...independentRequest.policy, messages: [{ role: "system", content: "Different prompt" }] } } };
  await expect(client.get("run")).rejects.toThrow("admitted policy");
  returned = { items: [independentDetails.summary], nextCursor: null };
  expect((await client.list({ projectId: "project" })).items).toHaveLength(1);
  // A linked Project can contain a run created before Project context was
  // written into the run summary. The host validates that link before listing.
  returned = { items: [summary], nextCursor: null };
  expect((await client.list({ projectId: "project" })).items).toHaveLength(1);
  returned = { items: [{ ...summary, teamId: "other" }], nextCursor: null };
  await expect(client.list({ projectId: "project" })).rejects.toThrow("another identity or workspace");
  returned = { ...modelDetails, policySnapshot: { ...snapshot, configurationHash: await canonicalSha256("changed-provider") } };
  await expect(client.get("run")).rejects.toThrow("admitted policy");

  // A native Profile result must bind its repository/source and package, not
  // merely borrow a matching model name from an unrelated Harness execution.
  const source = { profileId: "profile", sourceRevision: "a".repeat(40), harnessRelease: legacy.harnessRelease,
    catalogHash: await canonicalSha256("catalog"), definitionId: "check", definitionHash: await canonicalSha256("definition"),
    target: { kind: "profile" as const }, environmentHash: await canonicalSha256("environment") };
  const harnessRequest = ModelTasksetRunRequestSchema.parse({ ...modelRequest, modelProjectId: null,
    population: [{ taskId: taskset.tasks[0]!.id, seed: "0", fixtureId: null,
      receiptId: `evaluation-${contentHash([manifest.id, taskset.tasks[0]!.id, "0"]).slice(0, 32)}` }], policy: {
    kind: "hosted_harness", modelId: "catalog-model", profileRepositoryId: "profile-repo", source,
    packageHash: manifest.packageHash, modelConfigurationHash: snapshot.configurationHash,
  } });
  const harnessManifest = createTasksetRunManifest({ ...manifestContent, population: harnessRequest.population,
    profileEvaluation: source, metadata: { profileRepositoryId: "profile-repo" }, policy: { kind: "model",
      model: { provider: "openpond", model: "catalog-model", revision: null, artifactHash: null, tokenizerRevision: null, chatTemplateHash: null },
      configurationHash: snapshot.configurationHash } });
  const harnessDetails = { ...details, request: harnessRequest, manifest: harnessManifest, policySnapshot: null,
    summary: { ...summary, modelProjectId: null, policyKind: "hosted_harness", manifestHash: harnessManifest.contentHash,
      totalCount: 1, counts: { pending: 1, running: 0, completed: 0, failed: 0, cancelled: 0 } } };
  returned = harnessDetails;
  expect((await client.create(harnessRequest)).manifest.profileEvaluation).toEqual(source);
  for (const policy of [
    { ...harnessRequest.policy, profileRepositoryId: "another-repo" },
    { ...harnessRequest.policy, source: { ...source, sourceRevision: "b".repeat(40) } },
    { ...harnessRequest.policy, packageHash: await canonicalSha256("changed-package") },
    { ...harnessRequest.policy, modelConfigurationHash: await canonicalSha256("changed-model") },
  ]) {
    returned = { ...harnessDetails, request: { ...harnessRequest, policy } };
    await expect(client.get("run")).rejects.toThrow("admitted source");
  }
  expect(ModelTasksetRunRequestSchema.safeParse({ ...harnessRequest, modelProjectId: "model" }).success).toBe(false);
  const definitionContent = { schemaVersion: "openpond.experimentDefinition.v1", id: "exp-native", teamId: "team", revision: 1,
    request: { ...harnessRequest, population: harnessRequest.population.map(member => ({ ...member, receiptId: "saved-member" })) },
    maximumCostUsd: 1, graders: [{ id: "grader", version: "1", contentHash: contentHash("grader"), feedbackKey: "accuracy", release: null }],
    createdAt: manifest.createdAt, updatedAt: manifest.createdAt };
  const definition = verifyExperimentDefinition({ ...definitionContent, contentHash: contentHash(definitionContent) });
  const reference = experimentDefinitionRef(definition);
  const { contentHash: _nativeManifestHash, ...harnessManifestContent } = harnessManifest;
  const startedManifest = createTasksetRunManifest({ ...harnessManifestContent, metadata: { ...harnessManifest.metadata,
    experimentDefinition: reference, experimentConfigurationHash: contentHash({ definition: reference, maximumCostUsd: 1, graders: definition.graders }) } });
  const startedRun = { ...harnessDetails, manifest: startedManifest, summary: { ...harnessDetails.summary, manifestHash: startedManifest.contentHash } };
  returned = { definition, run: startedRun };
  const experiments = new OpenPondExperimentsClient({ baseUrl: "https://host.invalid", apiKey: "test", teamId: "team",
    fetch: async () => Response.json(returned) });
  expect((await experiments.start({ operationId: "op", definition: reference })).request.population).toEqual(harnessRequest.population);
  const changedDefinitionContent = { ...definitionContent, request: { ...definitionContent.request,
    population: definitionContent.request.population.map(member => ({ ...member, seed: "1" })) } };
  const changedDefinition = verifyExperimentDefinition({ ...changedDefinitionContent, contentHash: contentHash(changedDefinitionContent) });
  returned = { definition: changedDefinition, run: startedRun };
  await expect(experiments.start({ operationId: "op", definition: experimentDefinitionRef(changedDefinition) })).rejects.toThrow("saved configuration");
});
