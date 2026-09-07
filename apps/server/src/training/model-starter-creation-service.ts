import type { ModelStarterCreationRequest } from "openpond-sdk/model-starters";
import { createHash } from "node:crypto";
import type { TrainingDestinationCapabilities } from "@openpond/contracts";
import { validateTaskset } from "@openpond/taskset-sdk";
import { ModelProjectConfigurationCheckSchema, type ModelProjectConfigurationCheck } from "openpond-sdk/model-projects";
import { canonicalJson } from "openpond-sdk/training";
import { createModelStarterExecutionAsset, parseModelStarterCreationRequest, previewModelStarter, validateResolvedModelStarter } from "openpond-sdk/model-starters";
import type { ModelStarterCommitInput } from "../store/store-model-starters.js";
import type { SqliteStore } from "../store/store.js";
import { projectBaseModelCandidates } from "./base-model-candidates.js";
import { requireLearningRelease } from "@openpond/evals/learning";

export interface LocalModelStarterCatalog {
  /** Resolve only trusted, pinned catalog publications. Never caller uploads. */
  resolve(reference: ModelStarterCreationRequest["starter"], profileId: string): Promise<Omit<ModelStarterCommitInput, "request" | "createdAt">>;
}

export function createModelStarterCreationService(input: { store: SqliteStore; home: string; catalog: LocalModelStarterCatalog; now?: () => string }) {
  return {
    async check(raw: unknown, authorizedProfileId: string, destinations: TrainingDestinationCapabilities[]) {
      const request = parseModelStarterCreationRequest(raw);
      if (request.profileId !== authorizedProfileId) throw new Error("Starter creation is outside the authorized Profile.");
      const checkedAt = input.now?.() ?? new Date().toISOString();
      const findings: ModelProjectConfigurationCheck["findings"] = [];
      const previous = await input.store.findModelStarterCreation(request);
      if (!previous) {
        const publication = await input.catalog.resolve(request.starter, authorizedProfileId);
        const prepared = await input.store.prepareModelStarterCreation({ ...publication, request, createdAt: checkedAt }).catch(error => {
          findings.push({ code: "starter_preparation_unavailable", severity: "error", field: "rewardBindingRef", message: error instanceof Error ? error.message : "The selected starter configuration cannot be prepared." });
          return null;
        });
        const resolved = validateResolvedModelStarter(publication.package);
        await input.store.learningRepository().transaction(request.profileId, async tx => {
          const resources = [...(resolved.execution ? [{ kind: "asset" as const, resource: createModelStarterExecutionAsset(resolved.execution) }] : []), ...resolved.assets.map(resource => ({ kind: "asset" as const, resource })), ...resolved.rewards.map(resource => ({ kind: "reward" as const, resource })), { kind: "binding" as const, resource: resolved.rewardBinding }, { kind: "definition" as const, resource: resolved.taskDefinition }];
          for (const { kind, resource } of resources) {
            const existing = await tx.get(kind, resource.id, resource.revision);
            if (existing && canonicalJson(existing) !== canonicalJson(resource)) findings.push({ code: "starter_dependency_conflict", severity: "error", field: kind, message: `A different ${kind} already occupies this starter dependency revision: ${resource.id}.` });
          }
          if (request.rewardBindingRef && canonicalJson(request.rewardBindingRef) !== canonicalJson({ id: resolved.rewardBinding.id, revision: resolved.rewardBinding.revision, contentHash: resolved.rewardBinding.contentHash })) {
            try {
              const binding = await requireLearningRelease(tx, "binding", request.rewardBindingRef);
              for (const source of binding.sources) await requireLearningRelease(tx, "reward", source.reward);
            } catch {
              findings.push({ code: "model_reward_unavailable", severity: "error", field: "rewardBindingRef", message: "The selected Reward is unavailable in this Profile." });
            }
          }
        });
        if (prepared) findings.push(...validateTaskset(prepared.taskset).issues.map(issue => ({ code: issue.code, severity: issue.severity, message: issue.message, field: issue.path ?? "taskset" })));
        if (await input.store.getModelProject(request.modelId)) findings.push({ code: "model_identity_exists", severity: "error", field: "modelId", message: "This model identity already exists. Open a new model setup." });
        const candidate = projectBaseModelCandidates({ destinations }).find(entry => canonicalJson(entry.preference) === canonicalJson(request.startingModel));
        if (!candidate?.available) findings.push({ code: "model_base_unavailable", severity: "error", field: "startingModel", message: "The selected starting model is unavailable on this execution owner." });
        else if (!candidate.executionOptions.some(option => option.available && option.methods.includes(request.method))) findings.push({ code: "starter_method_unavailable", severity: "warning", field: "method", message: "This model can be saved, but no available destination supports its training method. Training remains unavailable until a compatible destination is configured." });
        findings.push({ code: "starter_training_not_checked", severity: "warning", field: null, message: "Training readiness and Reward quality require separate execution checks." });
      }
      return ModelProjectConfigurationCheckSchema.parse({
        schemaVersion: "openpond.modelProjectConfigurationCheck.v1", configurationHash: createHash("sha256").update(canonicalJson(request)).digest("hex"),
        projectId: request.modelId, expectedRevision: 0, checkedAt, canSave: !findings.some(finding => finding.severity === "error"), deferred: [],
        findings: [...findings.filter(finding => finding.severity === "error"), ...findings.filter(finding => finding.severity === "warning")].slice(0, 100),
      });
    },
    async preview(reference: ModelStarterCreationRequest["starter"], profileId: string) {
      const publication = await input.catalog.resolve(reference, profileId);
      const resolved = validateResolvedModelStarter(publication.package);
      if (resolved.starter.id !== reference.id || resolved.starter.revision !== reference.revision || resolved.starter.contentHash !== reference.contentHash) throw new Error("Catalog returned a different starter revision.");
      return previewModelStarter(resolved);
    },
    async create(raw: unknown, authorizedProfileId: string) {
      const request = parseModelStarterCreationRequest(raw);
      if (request.profileId !== authorizedProfileId) throw new Error("Starter creation is outside the authorized Profile.");
      const previous = await input.store.findModelStarterCreation(request);
      if (previous) return previous;
      const publication = await input.catalog.resolve(request.starter, authorizedProfileId);
      const commit = { ...publication, request, createdAt: input.now?.() ?? new Date().toISOString() };
      return input.store.saveModelStarterCreation(commit);
    },
  };
}
