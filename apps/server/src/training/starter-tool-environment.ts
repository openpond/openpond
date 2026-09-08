import type { TaskDataRecord, Taskset } from "@openpond/contracts";
import { createLearningTextAsset, learningRef, requireLearningRelease, requireLearningResource, verifyLearningTextAsset, type LearningTextAsset } from "@openpond/evals/learning";
import { createAgentSnapshot, createHarnessRelease } from "@openpond/harness";
import { compileBoundGraders } from "@openpond/evals/rewards";
import { TaskRecordSchema } from "@openpond/evals/tasksets";
import { ModelProjectVersionedRefSchema } from "openpond-sdk/model-projects";
import { ModelStarterExecutionSchema, modelStarterExecutionAssetId, resolveModelStarterExecutionAsset } from "openpond-sdk/model-starters";
import { contentHash } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import { loadOrdinaryToolEnvironment } from "./ordinary-tool-environment.js";

export const STARTER_TOOL_ENVIRONMENT = "openpond.javascript-environment.v1";

/** Resolve only the selected task's private world from the execution owner's store. */
export async function loadStarterToolEnvironment(store: SqliteStore, taskset: Taskset, task: TaskDataRecord, storeDir?: string) {
  const saved = taskset.tasks.find(candidate => candidate.id === task.id);
  if (!saved || contentHash(saved) !== contentHash(task)) throw new Error("Tool task differs from the selected immutable Taskset.");
  if (taskset.metadata.taskDefinition === undefined) return loadOrdinaryToolEnvironment(taskset, task, storeDir);
  return store.learningRepository().transaction(taskset.profileId, async tx => {
    const definition = await requireLearningRelease(tx, "definition", ModelProjectVersionedRefSchema.parse(taskset.metadata.taskDefinition));
    const contract = definition.execution.environment;
    if (contract.entrypoint !== STARTER_TOOL_ENVIRONMENT || taskset.environment.entrypoint !== STARTER_TOOL_ENVIRONMENT ||
        taskset.environment.kind !== "agent" || taskset.environment.stateful !== contract.stateful ||
        taskset.environment.defaultTimeoutMs !== contract.defaultTimeoutMs || taskset.environment.networkPolicy !== contract.networkPolicy ||
        taskset.environment.deterministicSeeds !== contract.deterministicSeeds ||
        contentHash(taskset.environment.toolNames) !== contentHash(definition.execution.tools.map(tool => tool.name)) ||
        contentHash(taskset.environment.metadata.portableTools) !== contentHash(definition.execution.tools) ||
        contentHash(taskset.policy) !== contentHash(definition.execution.policy) ||
        contentHash(taskset.metadata.rewardBinding) !== contentHash(definition.rewardBinding)) {
      throw new Error("Tool Taskset context differs from its pinned task definition.");
    }
    const binding = await requireLearningRelease(tx, "binding", definition.rewardBinding);
    const rewards = await Promise.all(binding.sources.map(source => requireLearningRelease(tx, "reward", source.reward)));
    const releasedTask = TaskRecordSchema.parse({ id: task.id, clusterKey: task.clusterKey, split: task.split, input: task.input, expectedOutput: task.expectedOutput, policyVisibleContext: task.policyVisibleContext, privilegedContextRef: task.privilegedContextRef, artifactRefs: [], tags: task.tags });
    const context = { ...definition.execution, graders: compileBoundGraders(binding, rewards), tasks: [releasedTask] };
    const executionAsset = await requireLearningResource(tx, "asset", modelStarterExecutionAssetId(context), 1);
    const declared = ModelStarterExecutionSchema.parse(JSON.parse(verifyLearningTextAsset(executionAsset, executionAsset.asset)));
    const references = [declared.javascript.module, declared.environment.actionSchemaRef, declared.environment.observationSchemaRef, declared.environment.stateSchemaRef].filter(reference => reference !== null);
    const ids = [...new Set([...references.map(reference => reference.id), task.privilegedContextRef].filter((id): id is string => id !== null))];
    const assets: LearningTextAsset[] = await Promise.all(ids.map(id => requireLearningResource(tx, "asset", id, 1)));
    const execution = resolveModelStarterExecutionAsset(context, executionAsset, assets);
    if (contentHash(taskset.environment.metadata.portableExecutionResources) !== contentHash({ environment: execution.environment, verifierSet: execution.verifierSet })) throw new Error("Tool Taskset publication differs from its private execution resources.");
    const module = assets.find(asset => asset.id === execution.javascript.module.id)!;
    const stateAsset = assets.find(asset => asset.id === task.privilegedContextRef)!;
    const initialState = JSON.parse(verifyLearningTextAsset(stateAsset, stateAsset.asset)) as Record<string, unknown>;
    return { execution, module, initialState, definition: learningRef(definition), instructions: definition.instructions, task: releasedTask };
  });
}

/** This adapter executes the Taskset-owned policy and module, not Profile skills. */
export function compileStarterToolHarness(resolved: Awaited<ReturnType<typeof loadStarterToolEnvironment>>) {
  const instructions = createLearningTextAsset({ text: resolved.instructions, path: "policy/instructions.txt", mediaType: "text/plain", visibility: "policy" });
  const dependencyLock = createLearningTextAsset({ text: JSON.stringify({ environment: learningRef(resolved.execution.environment), verifierSet: learningRef(resolved.execution.verifierSet), javascript: learningRef(resolved.execution.javascript) }), path: "environment/dependencies.json", mediaType: "application/json", visibility: "host_private" });
  const agentSnapshot = createAgentSnapshot({
    schemaVersion: "openpond.agentSnapshot.v2", id: `starter-agent-${resolved.definition.contentHash}`,
    sourceRelease: { id: resolved.definition.id, contentHash: resolved.definition.contentHash },
    instructions: [instructions.asset], skills: [], agents: [], toolDeclarations: resolved.execution.javascript.tools,
    capabilityRequirements: [], dependencyLock: dependencyLock.asset,
    portability: { portable: true, blockers: [], localOnlyAssetRefs: [], hostPrivateAssetRefs: [resolved.module.id, dependencyLock.id] },
    metadata: { execution: STARTER_TOOL_ENVIRONMENT },
  });
  const harnessRelease = createHarnessRelease({
    schemaVersion: "openpond.harnessRelease.v2", id: `starter-harness-${agentSnapshot.contentHash}`,
    agentSnapshot: { id: agentSnapshot.id, contentHash: agentSnapshot.contentHash }, program: resolved.module.asset,
    tools: resolved.execution.javascript.tools,
    lifecycle: { create: true, reset: true, step: true, collect: true, destroy: true, resetScope: "attempt" },
    graderInterface: { visibleEvidence: ["output"], privilegedEvidence: ["environment_state", "private_verifier"], privateVerifierIsolation: true },
    files: [instructions.asset, dependencyLock.asset, resolved.module.asset], metadata: { execution: STARTER_TOOL_ENVIRONMENT },
  });
  return { agentSnapshot, harnessRelease, instructionContext: undefined };
}
