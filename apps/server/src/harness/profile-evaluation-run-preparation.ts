import { z } from "zod";

import { ChatModelRefSchema, ModelRefSchema, ProfileComponentBindingSchema, ReleaseHashSchema, ReleaseIdSchema, ReleaseTimestampSchema, contentHash, type ChatModelRef } from "@openpond/harness";
import { type OpenPondProfileRef } from "@openpond/contracts";
import {
  assertProfileEvaluationRunAdmission,
  createTasksetRunManifest,
  resolveProfileEvaluationRunSource,
  tasksetRunMetricPolicy,
  type ProfileEvaluationDefinition,
} from "@openpond/evals";
import { validateTasksetPackage, type TasksetPackage } from "openpond-sdk/taskset-packages";

import type { SqliteStore } from "../store/store.js";
import { profileEvaluationsForRelease } from "./local-profile-evaluation-runtime.js";
import { type ProfileWorkflow } from "@openpond/harness";

const PrepareRequestSchema = z.object({
  id: ReleaseIdSchema,
  createdAt: ReleaseTimestampSchema,
  definitionId: ReleaseIdSchema,
  modelRef: ChatModelRefSchema,
  /** Trusted embedding host's resolved model configuration receipt. Desktop
   * computes this itself and ignores the caller's value. */
  hostModelConfigurationHash: ReleaseHashSchema.optional(),
}).strict();

type SelectedWorkflows = {
  profileRef: OpenPondProfileRef;
  sourceRevision: string;
  harnessRelease: { id: string; contentHash: string };
  workflows: Array<{ workflow: ProfileWorkflow; binding: {
    schemaVersion: "openpond.profileWorkflowBinding.v1";
    profileId: string;
    sourceRevision: string;
    harnessRelease: { id: string; contentHash: string };
    catalogHash: string;
    workflowId: string;
  } }>;
};

/** Build a complete, immutable run request from the selected released Profile
 * and the exact Taskset package named by its verifier-private definition. */
export function createProfileEvaluationRunPreparationService(input: {
  store: SqliteStore;
  selectedWorkflows: () => Promise<SelectedWorkflows>;
  loadTasksetPackage: (definition: ProfileEvaluationDefinition, profileId: string, harnessRelease: { id: string; contentHash: string }) => Promise<TasksetPackage>;
  modelConfigurationHash: (modelRef: ChatModelRef, request: z.infer<typeof PrepareRequestSchema>) => Promise<string>;
  placement: "local" | "remote" | "colocated";
}) {
  return async (request: unknown) => {
    const parsed = PrepareRequestSchema.parse(request);
    const selected = await input.selectedWorkflows();
    const discovered = await profileEvaluationsForRelease({
      store: input.store,
      ref: selected.profileRef,
      sourceRevision: selected.sourceRevision,
      harnessRelease: selected.harnessRelease,
    });
    const catalog = {
      schemaVersion: "openpond.profileEvaluations.v1" as const,
      definitions: discovered.definitions,
      suites: discovered.suites,
    };
    const definition = discovered.definitions.find((item) => item.id === parsed.definitionId);
    if (!definition) throw new Error(`Evaluation ${parsed.definitionId} is absent from the selected Profile release.`);
    const target = definition.target;
    const binding = target.kind === "workflow"
      ? selected.workflows.find((entry) => entry.binding.workflowId === target.workflowId)?.binding
      : ProfileComponentBindingSchema.parse({
        schemaVersion: "openpond.profileComponentBinding.v1",
        profileId: selected.profileRef.profileId,
        sourceRevision: selected.sourceRevision,
        harnessRelease: selected.harnessRelease,
        target,
      });
    if (!binding) throw new Error(`Evaluation workflow ${target.kind === "workflow" ? target.workflowId : ""} is absent from the selected Profile release.`);
    const packageValue = validateTasksetPackage(await input.loadTasksetPackage(definition, selected.profileRef.profileId, selected.harnessRelease));
    const taskset = packageValue.taskset;
    if (taskset.id !== definition.tasksetRelease.id || taskset.contentHash !== definition.tasksetRelease.contentHash) {
      throw new Error("Evaluation Taskset package differs from its released definition.");
    }
    if (taskset.environment.kind !== "text" || taskset.tools.length
      || taskset.tasks.some((task) => task.artifactRefs.length)) {
      throw new Error("Workflow evaluation requires text cases with policy-visible input; Taskset-owned tools and file assets are unavailable in the Profile turn runtime.");
    }
    const runtimeTarget = {
      adapterId: target.kind === "workflow" ? "openpond.profile-workflow" : "openpond.profile-component",
      placement: input.placement,
      runtimeVersion: "app-server-v1",
      capabilityReceipt: contentHash({
        adapterId: target.kind === "workflow" ? "openpond.profile-workflow" : "openpond.profile-component",
        packageHash: packageValue.contentHash,
        connectedAppScopes: taskset.policy.connectedAppScopes,
      }),
    } as const;
    const source = resolveProfileEvaluationRunSource({
      catalog, definitionId: definition.id,
      profileId: selected.profileRef.profileId,
      sourceRevision: selected.sourceRevision,
      harnessRelease: selected.harnessRelease,
      environmentHash: contentHash({ packageHash: packageValue.contentHash, runtimeTarget }),
    });
    const model = ModelRefSchema.parse({
      provider: parsed.modelRef.providerId,
      model: parsed.modelRef.modelId,
      revision: null, artifactHash: null, tokenizerRevision: null, chatTemplateHash: null,
    });
    const modelConfigurationHash = await input.modelConfigurationHash(parsed.modelRef, parsed);
    const manifest = createTasksetRunManifest({
      schemaVersion: "openpond.tasksetRunManifest.v1",
      id: parsed.id,
      tasksetRelease: definition.tasksetRelease,
      packageHash: packageValue.contentHash,
      execution: { kind: "harness", harnessRelease: selected.harnessRelease },
      profileEvaluation: source,
      policy: { kind: "model", model, configurationHash: modelConfigurationHash },
      gradingRole: "evaluation",
      metricPolicy: tasksetRunMetricPolicy(taskset),
      population: definition.taskIds.flatMap((taskId) => definition.seeds.map((seed) => ({
        receiptId: `evaluation-${contentHash([parsed.id, taskId, seed]).slice(0, 32)}`,
        taskId, seed, fixtureId: null,
      }))),
      runtimeTarget,
      limits: {
        maxTurns: 128,
        timeoutMs: taskset.environment.defaultTimeoutMs,
        maxOutputBytes: 250_000_000,
        maximumSpendUsd: null,
      },
      createdAt: parsed.createdAt,
      metadata: { sourceTasksetId: taskset.metadata.sourceTasksetId ?? taskset.id },
    });
    assertProfileEvaluationRunAdmission(manifest, taskset, catalog);
    return {
      manifest, taskset,
      profileRef: selected.profileRef,
      binding,
      modelRef: parsed.modelRef,
      modelConfigurationHash,
    };
  };
}
