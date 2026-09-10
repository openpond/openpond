import { TasksetDraftSchema, type GraderFixture, type GeneratedTaskFile, type TasksetSourceRef } from "@openpond/contracts";
import { learningRef, sameLearningRef, verifyLearningTextAsset } from "@openpond/evals/learning";
import { computeTasksetHash, createTasksetDraft, learningVerifierModule, projectLearningBatchGraders, publishTasksetDraft } from "@openpond/taskset-sdk";
import { deriveModelTaskset, ModelStarterToolFixtureScriptSchema, validateModelStarterCreation, type ModelStarterCreationRequest, type ModelTasksetPackage } from "openpond-sdk/model-starters";

/** Trusted catalog publication supplies authored fixtures and reviewed training
 * targets. These inputs are not accepted from the final model-creation request.
 * Fixture expectations remain authored assertions until readiness executes them. */
export function prepareModelStarterTaskset(input: {
  request: ModelStarterCreationRequest;
  package: unknown;
  source: TasksetSourceRef;
  fixtures: GraderFixture[];
  approvedTrainingTaskIds: string[];
  createdAt: string;
  rewardSelection?: Pick<ModelTasksetPackage, "rewardBinding" | "rewards" | "assets">;
}) {
  const { request, resolved } = validateModelStarterCreation(input.request, input.package);
  const { starter, ...sourcePackage } = resolved;
  const selected = request.rewardBindingRef && !sameLearningRef(request.rewardBindingRef, learningRef(resolved.rewardBinding));
  if (selected && (!input.rewardSelection || !sameLearningRef(request.rewardBindingRef!, learningRef(input.rewardSelection.rewardBinding)))) throw new Error("The selected starter Reward is unavailable for package preparation.");
  const resources: ModelTasksetPackage = deriveModelTaskset({ owner: { scopeId: request.profileId, modelId: request.modelId }, source: sourcePackage, ...(selected ? input.rewardSelection! : { rewardBinding: sourcePackage.rewardBinding, rewards: sourcePackage.rewards, assets: sourcePackage.assets }) });
  const { taskset: release, taskDefinition, rewardBinding, rewards, assets } = resources;
  if (input.source.profileId !== request.profileId || input.source.sourceHash !== starter.contentHash) throw new Error("Starter source must belong to this Profile and pin the catalog package.");
  const toolEnvironment = resources.execution !== undefined;
  const textEnvironment = release.environment.kind === "text" && release.environment.entrypoint === "openpond.text.v1" && !release.environment.stateful && ((!release.environmentRelease && !release.verifierSetRelease) || resources.executionResources !== undefined) && !release.capabilities.length && !release.tools.length;
  if (!["sft", "grpo"].includes(request.method) || taskDefinition.harness || (!textEnvironment && !toolEnvironment) || release.tasks.some(task => task.artifactRefs.length) || release.graders.some(grader => grader.kind === "model_judge" && (!grader.model || grader.calibrationStatus !== "passed"))) throw new Error("This starter requires an additional training or environment adapter before preparation.");
  const approved = new Set(input.approvedTrainingTaskIds);
  if (approved.size !== input.approvedTrainingTaskIds.length) throw new Error("Starter training approvals must be unique.");
  for (const id of approved) {
    const task = release.tasks.find(task => task.id === id);
    if (!task || task.split !== "train" || task.expectedOutput === null) throw new Error(`Starter approval must reference a training task with a target: ${id}.`);
  }
  if (request.method === "grpo" && release.tasks.some(task => task.split === "train" && !approved.has(task.id))) throw new Error("GRPO starter preparation requires approval of every training task's reference target.");
  for (const fixture of input.fixtures) {
    if (!release.tasks.some(task => task.id === fixture.taskId)) throw new Error(`Starter fixture references an unknown task: ${fixture.taskId}.`);
    if (toolEnvironment && !fixture.infrastructureError) ModelStarterToolFixtureScriptSchema.parse(fixture.metadata.toolScript);
  }
  const tasksetId = release.id;
  const draft = createTasksetDraft({ profileId: request.profileId, id: `${tasksetId}-draft`, name: starter.name, now: input.createdAt });
  const files: GeneratedTaskFile[] = [];
  for (const grader of release.graders) {
    if (grader.kind !== "custom_verifier") continue;
    const asset = assets.find(asset => asset.id === grader.verifierRef.id);
    if (!asset) throw new Error(`Starter verifier asset is missing: ${grader.id}.`);
    const path = learningVerifierModule(grader.verifierRef.contentHash);
    if (!files.some(file => file.path === path)) files.push({ path, role: "verifier", content: verifyLearningTextAsset(asset, grader.verifierRef) });
  }
  const authored = TasksetDraftSchema.parse({
    ...draft,
    objective: taskDefinition.instructions,
    metrics: release.metrics ?? draft.metrics,
    sourceRefs: [input.source],
    policy: release.policy,
    environment: { ...draft.environment, kind: toolEnvironment ? "agent" : "chat", entrypoint: release.environment.entrypoint, stateful: release.environment.stateful, toolNames: release.tools.map(tool => tool.name), deterministicSeeds: release.environment.deterministicSeeds, defaultTimeoutMs: release.environment.defaultTimeoutMs, networkPolicy: release.environment.networkPolicy, metadata: { portableEnvironment: release.environment, portableTools: release.tools, ...(resources.executionResources ? { portableExecutionResources: resources.executionResources } : resources.execution ? { portableExecutionResources: { environment: resources.execution.environment, verifierSet: resources.execution.verifierSet } } : {}) } },
    output: { mode: "structured_json", jsonSchema: taskDefinition.outputSchema, renderer: null },
    capabilities: { ...draft.capabilities, taskKind: toolEnvironment ? "single_agent" : "chat", requiresTools: toolEnvironment, requiresState: toolEnvironment, supportedSignals: request.method === "grpo" ? ["demonstration", "reward"] : ["demonstration"], compatibleMethods: [request.method], rewardKinds: [...new Set(release.graders.map(grader => grader.kind === "human" ? "human" : grader.kind === "model_judge" ? "model_judge" : "deterministic"))], requiresPrivilegedGrading: true, environmentPlacements: ["local", "remote"] },
    tasks: release.tasks.map(({ artifactRefs: _artifacts, ...task }) => ({ ...task, schemaVersion: "openpond.taskData.v1", sourceRefs: [input.source.id], metadata: { exampleOrigin: "curated_starter", starter: learningRef(starter), portableTaskRecord: { ...task, artifactRefs: [] } } })),
    graders: projectLearningBatchGraders(rewardBinding, rewards, assets),
    graderFixtures: input.fixtures,
    learningSignals: { ...draft.learningSignals, rewards: request.method === "grpo" ? release.tasks.filter(task => approved.has(task.id)).map(task => ({
      kind: "reward", id: `starter-reward-${task.id}`, taskId: task.id, task: taskDefinition.instructions,
      rules: [{ id: rewardBinding.id, points: 1, condition: "Execute the published Reward binding with its declared normalization, weights and required gates." }],
      otherwisePoints: 0, executable: true, approved: true, confidence: 1, sourceRefs: [input.source.id], artifactRef: rewardBinding.id,
      metadata: { starter: learningRef(starter), rewardBinding: learningRef(rewardBinding), approvalOrigin: "catalog_publication" },
    })) : [], demonstrations: release.tasks.filter(task => approved.has(task.id)).map(task => ({
      kind: "demonstration", id: `starter-target-${task.id}`, taskId: task.id, sourceRefs: [input.source.id], artifactRef: release.id,
      approved: true, confidence: 1, prompt: null, response: JSON.stringify(task.expectedOutput), metadata: { starter: learningRef(starter), approvalOrigin: "catalog_publication" },
    })) },
    metadata: { starter: learningRef(starter), starterTasksetRelease: learningRef(release), taskDefinition: learningRef(taskDefinition), rewardBinding: learningRef(rewardBinding), rewardExecution: { binding: rewardBinding, rewards }, portableCapabilities: release.capabilities, derivedPortableMetadata: release.metadata, modelTasksetDerivation: release.metadata.modelTasksetDerivation },
  });
  const taskset = publishTasksetDraft({ draft: authored, now: input.createdAt, tasksetId, sourcePackageHash: release.contentHash });
  // A draft's editor default is not an authored policy on the pinned release.
  taskset.metrics = release.metrics;
  taskset.contentHash = computeTasksetHash(taskset);
  return { draft: authored, taskset, generatedFiles: files, resources };
}
