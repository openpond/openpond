import { TasksetDraftSchema, type GraderFixture, type GeneratedTaskFile, type TasksetSourceRef } from "@openpond/contracts";
import { learningRef, verifyLearningTextAsset } from "@openpond/evals/learning";
import { contentHash, createTasksetDraft, learningVerifierModule, projectLearningBatchGraders, publishTasksetDraft } from "@openpond/taskset-sdk";
import { ModelStarterToolFixtureScriptSchema, validateModelStarterCreation, type ModelStarterCreationRequest } from "openpond-sdk/model-starters";

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
}) {
  const { request, resolved } = validateModelStarterCreation(input.request, input.package);
  const { starter, taskset: release, taskDefinition, rewardBinding, rewards, assets } = resolved;
  if (input.source.profileId !== request.profileId || input.source.sourceHash !== starter.contentHash) throw new Error("Starter source must belong to this Profile and pin the catalog package.");
  const toolEnvironment = resolved.execution !== undefined;
  const textEnvironment = release.environment.kind === "text" && release.environment.entrypoint === "openpond.text.v1" && !release.environment.stateful && !release.environmentRelease && !release.verifierSetRelease && !release.capabilities.length && !release.tools.length;
  if (!["sft", "grpo"].includes(request.method) || taskDefinition.harness || (!textEnvironment && !toolEnvironment) || release.tasks.some(task => task.artifactRefs.length) || release.graders.some(grader => grader.kind === "model_judge")) throw new Error("This starter requires an additional training or environment adapter before preparation.");
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
  const tasksetId = `starter-${contentHash({ request, createdAt: input.createdAt }).slice(0, 40)}`;
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
    sourceRefs: [input.source],
    policy: release.policy,
    environment: { ...draft.environment, kind: toolEnvironment ? "agent" : "chat", entrypoint: release.environment.entrypoint, stateful: release.environment.stateful, toolNames: release.tools.map(tool => tool.name), deterministicSeeds: release.environment.deterministicSeeds, defaultTimeoutMs: release.environment.defaultTimeoutMs, networkPolicy: release.environment.networkPolicy, metadata: { portableEnvironment: release.environment, portableTools: release.tools, ...(resolved.execution ? { portableExecutionResources: { environment: resolved.execution.environment, verifierSet: resolved.execution.verifierSet } } : {}) } },
    output: { mode: "structured_json", jsonSchema: taskDefinition.outputSchema, renderer: null },
    capabilities: { ...draft.capabilities, taskKind: toolEnvironment ? "single_agent" : "chat", requiresTools: toolEnvironment, requiresState: toolEnvironment, supportedSignals: request.method === "grpo" ? ["demonstration", "reward"] : ["demonstration"], compatibleMethods: [request.method], rewardKinds: [...new Set(release.graders.map(grader => grader.kind === "human" ? "human" : "deterministic"))], requiresPrivilegedGrading: true, environmentPlacements: ["local", "remote"] },
    tasks: release.tasks.map(({ artifactRefs: _artifacts, ...task }) => ({ ...task, schemaVersion: "openpond.taskData.v1", sourceRefs: [input.source.id], metadata: { exampleOrigin: "curated_starter", starter: learningRef(starter) } })),
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
    metadata: { starter: learningRef(starter), starterTasksetRelease: learningRef(release), taskDefinition: learningRef(taskDefinition), rewardBinding: learningRef(rewardBinding), rewardExecution: { binding: rewardBinding, rewards } },
  });
  return { draft: authored, taskset: publishTasksetDraft({ draft: authored, now: input.createdAt, tasksetId, sourcePackageHash: starter.contentHash }), generatedFiles: files };
}
