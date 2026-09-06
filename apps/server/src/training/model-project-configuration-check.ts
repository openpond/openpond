import { canonicalJson } from "openpond-sdk/training";
import {
  ModelProjectConfigurationCheckSchema,
  modelProjectConfigurationHash,
  parseModelProjectSaveRequest,
  type ModelProjectConfigurationCheck,
} from "openpond-sdk/model-projects";
import { validateTaskset } from "@openpond/taskset-sdk";
import { requireLearningRelease } from "@openpond/evals/learning";
import type { TrainingDestinationCapabilities } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import { projectBaseModelCandidates } from "./base-model-candidates.js";
import { loadSelectedLocalHarnessRuntime } from "../harness/local-harness-skill-runtime.js";

/** Resolves the submitted configuration against current server-owned resources.
 * This allocates no compute and never changes the Model or selected Taskset.
 */
export async function checkModelProjectConfiguration(input: {
  store: SqliteStore;
  request: unknown;
  destinations: () => Promise<TrainingDestinationCapabilities[]>;
}): Promise<ModelProjectConfigurationCheck> {
  const request = parseModelProjectSaveRequest(input.request);
  const { project, expectedRevision } = request;
  const configurationHash = await modelProjectConfigurationHash(request);
  if (await input.store.findModelProjectConfigurationSave(request)) return ModelProjectConfigurationCheckSchema.parse({
    schemaVersion: "openpond.modelProjectConfigurationCheck.v1", configurationHash,
    projectId: project.id, expectedRevision, checkedAt: new Date().toISOString(), canSave: true,
    deferred: [], findings: [{ code: "model_configuration_saved", severity: "warning", field: null,
      message: "This exact configuration was already saved. Retrying returns its saved version." }],
  });
  const findings: ModelProjectConfigurationCheck["findings"] = [];
  const deferred: ModelProjectConfigurationCheck["deferred"] = [];
  const error = (code: string, message: string, field: string) => findings.push({ code, message, field, severity: "error" });
  const existing = await input.store.getModelProject(project.id);
  if (existing && existing.profileId !== project.profileId) {
    error("model_not_found", "Model is not available in this Profile.", "id");
  } else if ((existing?.revision ?? 0) !== expectedRevision) {
    error("model_revision_conflict", "Model changed since it was opened. Refresh before saving.", "expectedRevision");
  }
  const preference = project.trainingSetup.baseModel ?? project.defaultBaseModel;
  if (!preference) deferred.push("base_model");
  else {
    const candidates = projectBaseModelCandidates({ destinations: await input.destinations() });
    const candidate = candidates.find((entry) => canonicalJson(entry.preference) === canonicalJson(preference));
    if (!candidate?.available) error("model_base_unavailable", "The selected starting model is unavailable on the execution owner. Choose an available model or choose later.", "trainingSetup.baseModel");
  }
  const ref = project.trainingSetup.tasksetRef;
  const rewardBindingRef = project.trainingSetup.rewardBindingRef;
  if (rewardBindingRef) {
    try {
      await input.store.learningRepository().transaction(project.profileId, async (tx) => {
        const binding = await requireLearningRelease(tx, "binding", rewardBindingRef);
        for (const source of binding.sources) await requireLearningRelease(tx, "reward", source.reward);
      });
      if (!ref) findings.push({ code: "model_reward_tasks_deferred", severity: "warning", field: "trainingSetup.rewardBindingRef", message: "Reward saved independently. Task compatibility will be checked when tasks are attached." });
    } catch {
      error("model_reward_unavailable", "The exact Reward configuration is unavailable in this Profile.", "trainingSetup.rewardBindingRef");
    }
  }
  if (!ref) {
    deferred.push("taskset");
    if (project.trainingSetup.tasksetRelease) error("model_taskset_required", "Choose the Taskset corresponding to this release.", "trainingSetup.tasksetRef");
  } else {
    const taskset = await input.store.getTasksetRevision(ref.id, ref.revision);
    if (!taskset || taskset.profileId !== project.profileId) error("model_taskset_not_found", "The selected Taskset revision is not available in this Profile.", "trainingSetup.tasksetRef");
    else if (taskset.contentHash !== ref.contentHash) error("model_taskset_changed", "The selected Taskset does not match its immutable content hash.", "trainingSetup.tasksetRef");
    else {
      findings.push(...validateTaskset(taskset).issues.map((finding) => ({
        code: finding.code, severity: finding.severity, message: finding.message,
        field: finding.path ? `taskset.${finding.path}` : "taskset",
      })));
      if (!taskset.tasks.length && !taskset.datasetArtifact) error("model_taskset_empty", "The selected Taskset has no tasks or dataset artifact.", "trainingSetup.tasksetRef");
      if (!taskset.readiness?.ready) findings.push({
        code: "model_training_not_checked", severity: "warning", field: "trainingSetup.tasksetRef",
        message: "Training readiness must be checked when preparing a run. This check verifies the selected configuration only.",
      });
    }
  }
  if (project.trainingSetup.harnessRelease) {
    try { await loadSelectedLocalHarnessRuntime(input.store, project.trainingSetup.harnessRelease); }
    catch { error("model_harness_unavailable", "The selected Harness release or its exact source is unavailable on this execution owner.", "trainingSetup.harnessRelease"); }
  }
  const canSave = !findings.some((finding) => finding.severity === "error");
  // Keep blocking findings visible when a large Taskset has many advisories.
  const bounded = [...findings.filter((finding) => finding.severity === "error"), ...findings.filter((finding) => finding.severity === "warning")].slice(0, 100);
  return ModelProjectConfigurationCheckSchema.parse({
    schemaVersion: "openpond.modelProjectConfigurationCheck.v1",
    configurationHash,
    projectId: project.id, expectedRevision, checkedAt: new Date().toISOString(), canSave, deferred, findings: bounded,
  });
}
