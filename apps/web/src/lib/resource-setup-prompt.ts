import type { BenchmarkModelVersion, ResourceSetupDraft } from "@openpond/contracts/resource-setup";
import { LocalSftReviewRequestSchema, ownsHostedBenchmarkVersion } from "@openpond/contracts/resource-setup";
import type { ChatContextSelection, ModelProject } from "@openpond/contracts";
import { createModelTrainingRecipeDefaults } from "openpond-sdk/model-starters";
import { canonicalJson, decisionSourcePreference, WEIGHT_SPACE_CHECKPOINT } from "openpond-sdk/training";
export { ResourceSetupDraftSchema, type ResourceSetupDraft } from "@openpond/contracts/resource-setup";

export type ResourceSetupField = keyof ResourceSetupDraft["values"];
export type ResourceSetupMethod = ResourceSetupDraft["values"]["method"];
export type ResourceSetupCandidate = BenchmarkModelVersion & { label: string };
export type ModelSetupScope = { accountKey: string; teamId: string | null; actorId: string | null; apiOrigin?: string | null };
export const benchmarkAccountMessage = "Choose the OpenPond account and workspace that owns this Benchmark.";
export const weightSpaceGeneration = { maxOutputTokens: 128, seed: 0, sampling: "greedy_v1" } as const;

export function isWeightSpaceSetup(draft: ResourceSetupDraft) {
  return draft.kind === "model" && draft.values.method === "Weight-space programming";
}

function scopedBenchmarkVersion(
  version: BenchmarkModelVersion | undefined,
  scope: ModelSetupScope | null,
  selection?: ChatContextSelection | null,
  sessionId?: string | null,
) {
  if (version?.location !== "cloud" || ownsHostedBenchmarkVersion(version, scope)) return version;
  const verified = selection?.benchmarkVersion;
  if (!version.owner && sessionId && selection?.target.sessionId === sessionId &&
    verified?.location === "cloud" && ownsHostedBenchmarkVersion(verified, scope) &&
    verified.teamId === version.teamId && verified.modelProjectId === version.modelProjectId &&
    verified.jobId === version.jobId && verified.versionHash === version.versionHash) return verified;
  return undefined;
}

export function canSubmitBenchmarkSetup(
  draft: ResourceSetupDraft, workspace: ModelSetupScope | null,
  selection: ChatContextSelection | null, sessionId: string | null,
) {
  if ((draft.managedBenchmarkVersions && !ownsHostedBenchmarkVersion(draft.managedBenchmarkVersions.candidate, workspace)) ||
    (draft.managedBenchmarkDataset && !ownsHostedBenchmarkVersion(draft.managedBenchmarkDataset, workspace)))
    return false;
  const version = draft.benchmarkModelVersion;
  return version?.location !== "cloud" || Boolean(scopedBenchmarkVersion(version, workspace, selection, sessionId));
}

export function scopeManagedSetup(
  draft: ResourceSetupDraft, scope: ModelSetupScope | null, selection?: ChatContextSelection | null, sessionId?: string | null,
) {
  const weightSpace = draft.weightSpace;
  if (weightSpace?.managed && (draft.values.destination !== "OpenPond Managed" || !ownsHostedBenchmarkVersion(weightSpace.managed, scope)))
    draft = { ...draft, weightSpace: { ...weightSpace, managed: undefined } };
  if (isWeightSpaceSetup(draft) && draft.values.destination === "OpenPond Managed" && (!scope?.actorId || !scope.teamId || !scope.apiOrigin))
    draft = { ...draft, values: { ...draft.values, destination: undefined } };
  const grader = draft.managedGrader;
  if (grader && (grader.accountKey !== scope?.accountKey || grader.teamId !== scope?.teamId ||
    grader.actorId !== scope?.actorId || grader.method !== draft.values.graderType)) {
    draft = { ...draft, managedGrader: undefined };
  }
  if (draft.managedBenchmarkVersions && !ownsHostedBenchmarkVersion(draft.managedBenchmarkVersions.candidate, scope))
    draft = { ...draft, managedBenchmarkVersions: undefined, managedBenchmarkProtocol: undefined,
      values: { ...draft.values, candidate: undefined, baseline: undefined } };
  if (draft.managedBenchmarkDataset && !ownsHostedBenchmarkVersion(draft.managedBenchmarkDataset, scope))
    draft = { ...draft, managedBenchmarkDataset: undefined, managedBenchmarkProtocol: undefined,
      values: { ...draft.values, dataset: undefined,
      datasetRevision: undefined, grader: undefined, split: undefined } };
  const version = scopedBenchmarkVersion(draft.benchmarkModelVersion, scope, selection, sessionId);
  if (draft.benchmarkModelVersion && !version)
    return { ...draft, benchmarkModelVersion: undefined, values: { ...draft.values, candidate: undefined } };
  if (version && version !== draft.benchmarkModelVersion) draft = { ...draft, benchmarkModelVersion: version };
  const managed = draft.managedTrainingInputs;
  if (!managed || draft.values.destination === "OpenPond Managed" && managed.accountKey === scope?.accountKey &&
    managed.teamId === scope?.teamId && managed.actorId === scope?.actorId && (!managed.apiOrigin || managed.apiOrigin === scope?.apiOrigin)) {
    if (managed?.batch && managed.batch.method !== resourceSetupManagedTrainingMethod(draft) &&
      !draft.datasetRef && draft.values.dataset === managed.batch.label)
      return { ...draft, values: { ...draft.values, dataset: undefined } };
    return draft;
  }
  return { ...draft, managedTrainingInputs: undefined, values: { ...draft.values,
    ...(managed.base ? { baseModel: undefined } : {}),
    ...(managed.batch && !draft.datasetRef ? { dataset: undefined, datasetRevision: undefined } : {}),
  } };
}

export function resourceSetupTrainingMethod(draft: ResourceSetupDraft): "sft" | "grpo" | null {
  return draft.kind !== "model" || draft.values.adapter === "Full fine-tuning" ? null
    : draft.values.method === "SFT" ? "sft"
      : draft.values.method === "GRPO" ? "grpo" : null;
}

export function resourceSetupManagedTrainingMethod(draft: ResourceSetupDraft) {
  return draft.kind === "model" && draft.values.method === "Decision"
    ? "decision_model" : resourceSetupTrainingMethod(draft);
}

export function resourceSetupSavedTrainingStart(draft: ResourceSetupDraft) {
  const method = resourceSetupManagedTrainingMethod(draft);
  const inputs = draft.managedTrainingInputs;
  return draft.values.destination === "OpenPond Managed" && inputs?.apiOrigin && method && method !== "sft"
    ? inputs.savedStarts?.[method] : undefined;
}

function localTrainingBase(draft: ResourceSetupDraft) {
  return draft.kind === "model" && draft.values.destination !== "OpenPond Managed" &&
    (!draft.values.method || resourceSetupTrainingMethod(draft) === "sft") ? draft.localTrainingBase : undefined;
}

export function modelSetupTrainingRecipe(draft: ResourceSetupDraft, method: "sft" | "grpo",
  baseModel?: ModelProject["trainingSetup"]["baseModel"]): NonNullable<ModelProject["trainingSetup"]["recipe"]> {
  const saved = draft.trainingRecipes?.[method];
  if (saved) return saved;
  const defaults = createModelTrainingRecipeDefaults(null, method, baseModel);
  const { epochs, learningRate } = draft.values;
  const optimizer = defaults.optimizer && typeof defaults.optimizer === "object" && !Array.isArray(defaults.optimizer) ? defaults.optimizer : {};
  return { ...defaults, optimizer: {
    ...optimizer,
    ...(epochs !== undefined && method === "sft" ? { epochs } : {}),
    ...(learningRate !== undefined ? { learningRate } : {}),
  } };
}

export function localSftReviewRequest(draft: ResourceSetupDraft, sessionId: string | null | undefined) {
  const base = localTrainingBase(draft)?.preference;
  if (!base || resourceSetupTrainingMethod(draft) !== "sft" || !sessionId || !draft.datasetRef?.contentHash) return null;
  const recipe = modelSetupTrainingRecipe(draft, "sft", base);
  const dataset = recipe.dataset as Record<string, unknown> | undefined;
  const parsed = LocalSftReviewRequestSchema.safeParse({
    sessionId, dataset: draft.datasetRef, modelAssetId: base.modelAssetId,
    recipe: {
      ...recipe,
      baseModel: {
        id: base.modelId, revision: base.revision, tokenizerRevision: base.tokenizerRevision, chatTemplateHash: base.chatTemplateHash,
      },
      dataset: {
        ...dataset, trainSplit: "train", validationSplit: dataset?.validationSplit ?? "validation",
        maxExamples: dataset?.maxExamples === "" ? undefined : dataset?.maxExamples,
      },
    },
  });
  return parsed.success ? parsed.data : null;
}

export function retainedLocalSftApproval(draft: ResourceSetupDraft, sessionId: string | null | undefined) {
  const approval = draft.localSftApproval;
  if (!approval) return undefined;
  const request = localSftReviewRequest(draft, sessionId);
  return request && canonicalJson(request) === canonicalJson(approval.request) ? approval : undefined;
}

function selectedTrainingRecipe(draft: ResourceSetupDraft, method: ReturnType<typeof resourceSetupTrainingMethod>) {
  if (!method) return undefined;
  const recipe = draft.trainingRecipes?.[method];
  const base = localTrainingBase(draft)?.preference;
  if (!recipe || method !== "sft" || !base) return recipe;
  return { ...recipe, baseModel: {
    id: base.modelId, revision: base.revision, tokenizerRevision: base.tokenizerRevision, chatTemplateHash: base.chatTemplateHash,
  } };
}

export function newResourceSetup(kind: ResourceSetupDraft["kind"]): ResourceSetupDraft {
  return {
    kind,
    revision: 1,
    values: kind === "dataset" ? { destination: "This device" } : {},
  };
}

export function selectModelSetupMethod(draft: ResourceSetupDraft, method: ResourceSetupMethod): ResourceSetupDraft {
  const adapter = method === "SFT" || method === "GRPO" ? "LoRA" as const : undefined;
  const destination = method !== "SFT" && draft.values.destination === "This device" ? undefined : draft.values.destination;
  if (draft.values.method === method && draft.values.adapter === adapter && draft.values.destination === destination) return draft;
  return { ...draft, revision: draft.revision + 1, values: { ...draft.values, method, adapter, destination } };
}

type PromptField = ResourceSetupField | "trainingSettings" | "evaluationSettings" | "saveDestination" | "preview"
  | "weightSpacePanels" | "weightSpaceFrozen" | "weightSpaceSettings";
export type ResourceSetupPart = string | { field: PromptField; placeholder: string };

const field = (key: PromptField, placeholder: string): ResourceSetupPart => ({ field: key, placeholder });

export function resourceSetupParts(draft: ResourceSetupDraft): ResourceSetupPart[] {
  const name = field("name", `Name the ${draft.kind}`);
  const objective = field("objective", "Choose an objective");
  const dataset = field("dataset", "Choose a dataset revision");
  const grader = field("grader", "Choose graders");
  const destination = field("destination", "Choose where to run");
  switch (draft.kind) {
    case "chat":
      return ["Help me ", objective, " in ", field("project", "Choose a project"), "."];
    case "model": {
      const method = draft.values.method;
      if (isWeightSpaceSetup(draft)) return [
        "Set up ", name, " for ", objective, " using ", field("baseModel", "Choose an exact editing checkpoint"),
        " with ", field("method", "Choose a training method"), ". Review ", field("weightSpacePanels", "Development and preservation prompts"),
        " and ", field("weightSpaceFrozen", "Optional frozen Dataset"), ". Use ", field("weightSpaceSettings", "Generation, limits, and budget"),
        ".", " Run on ", destination, ".",
      ];
      const adapter = method !== "Decision";
      return [
        "Set up ", name, " for ", objective, " using ", field("baseModel", "Choose a starting model or checkpoint"),
        " with ", field("method", "Choose a training method"),
        ...(adapter ? [" and a ", field("adapter", "Choose an adapter"), " adapter"] : []), ".",
        ...(method === "Decision"
          ? [" Use ", field("dataset", "Choose a reviewed Decision batch"), ". Show me the plan with ", field("trainingSettings", "Decision training settings"), "."]
          : [" Use ", dataset, " with ", field("grader", method === "GRPO" ? "Choose a reward grader" : "Choose a grader"), ".",
            " Show me the plan with ", field("trainingSettings", "Training settings"), " and ", field("learning", "Learning settings"), "."]),
        " Run on ", destination, ".",
      ];
    }
    case "benchmark":
      return [
        "Set up ", name, " for ", objective, ". Evaluate ", field("candidate", "Choose a candidate version"),
        ...(draft.comparison ? [" against ", field("baseline", "Choose a baseline version")] : []),
        " on ", dataset, " with ", grader, ". Use ", field("evaluationSettings", "Evaluation protocol"),
        ...(draft.benchmarkModelVersion?.location === "local" ? ["."] : [" and ", field("budget", "Choose a budget"), "."]),
        " Run on ", destination, ".",
      ];
    case "dataset":
      return ["Set up ", name, " for ", objective, " from ", field("source", "Choose a source"), " with ",
        draft.values.source === "Use an existing dataset" ? dataset : field("fields", "Choose input and expected output fields"), ". Show me ",
        field("preview", "Preview rows"), " before saving to ", field("saveDestination", "Choose where to save"), "."];
    case "grader":
      return ["Set up ", name, " as a ", field("graderType", "Choose a grader type"), " for ", dataset,
        ". Score ", field("criterion", "Choose a scoring criterion"), ". Show me how it handles ",
        field("cases", "Passing and failing examples"), "."];
  }
}

export const resourceSetupGroups: Partial<Record<PromptField, readonly ResourceSetupField[]>> = {
  dataset: ["dataset", "datasetRevision", "split"],
  trainingSettings: ["epochs", "learningRate", "budget"],
  evaluationSettings: ["samples", "seed"],
  saveDestination: ["destination"],
  preview: ["split", "samples"],
};

export function resourceSetupLabel({ field, placeholder }: Exclude<ResourceSetupPart, string>, draft: ResourceSetupDraft): string {
  if (field === "saveDestination") return draft.values.destination ?? placeholder;
  if (field === "preview" && draft.datasetExamples?.length)
    return `Preview ${draft.datasetExamples.length} ${draft.datasetExamples.length === 1 ? "row" : "rows"}`;
  if (field === "trainingSettings" || field === "evaluationSettings" || field === "preview") return placeholder;
  if (field === "weightSpacePanels") {
    const rows = draft.weightSpace?.panels?.reduce((count, panel) => count + panel.prompts.filter(row => row.text.trim()).length, 0);
    return rows ? `${rows} ${rows === 1 ? "editing prompt" : "editing prompts"}` : placeholder;
  }
  if (field === "weightSpaceFrozen") {
    const frozen = draft.weightSpace?.managed?.frozenEvaluation;
    return frozen ? `Frozen Dataset revision ${frozen.revision}` : placeholder;
  }
  if (field === "weightSpaceSettings") return placeholder;
  if (field === "baseModel" && isWeightSpaceSetup(draft))
    return draft.weightSpace?.managed?.checkpoint?.modelId ?? WEIGHT_SPACE_CHECKPOINT.modelId;
  if (field === "baseModel") {
    const savedStart = resourceSetupSavedTrainingStart(draft);
    if (savedStart) return savedStart.label;
    if (resourceSetupManagedTrainingMethod(draft) === "decision_model" && draft.values.destination === "OpenPond Managed")
      return decisionSourcePreference().modelId;
  }
  const localBase = localTrainingBase(draft);
  if (field === "baseModel" && localBase) return localBase.label;
  if (draft.benchmarkModelVersion?.location === "local") {
    if (field === "destination") return draft.localBenchmarkInference?.device === "cuda" ? "This device (NVIDIA CUDA)" : "This device (CPU)";
    if (field === "grader") return "the Dataset’s local graders";
  }
  if (field === "grader" && draft.managedBenchmarkDataset) {
    const selected = draft.managedBenchmarkDataset.graders?.length;
    return selected === undefined ? "the released graders" : selected ? `${selected} exact ${selected === 1 ? "grader" : "graders"}` : placeholder;
  }
  if (field === "grader" && draft.kind === "benchmark" && draft.values.destination === "This device") return "the Dataset’s local graders";
  const value = draft.values[field];
  if (field === "budget" && typeof value === "number") return `$${value}`;
  if (field === "dataset" && draft.managedBenchmarkDataset)
    return `${draft.managedBenchmarkDataset.label} revision ${draft.managedBenchmarkDataset.release.revision}`;
  if (field === "dataset" && value && draft.values.datasetRevision) return `${value} revision ${draft.values.datasetRevision}`;
  if (value === undefined && draft.kind === "model" && draft.values.method === "SFT") {
    if (field === "dataset") return "GSM8K example";
    if (field === "grader") return "Exact numeric answer example";
  }
  return value === undefined ? placeholder : String(value);
}

export function resourceSetupText(draft: ResourceSetupDraft): string {
  const parts = resourceSetupParts(draft);
  const destination = parts.findIndex(part => typeof part !== "string" && part.field === "destination");
  const destinationStart = destination < 0 ? parts.length : destination - 1;
  const stringify = (part: ResourceSetupPart) => {
    if (typeof part === "string") return part;
    const label = resourceSetupLabel(part, draft);
    return label === part.placeholder ? `[${label}]` : label;
  };
  const prompt = parts.slice(0, destinationStart).map(stringify).join("");
  const execution = parts.slice(destinationStart).map(stringify).join("").trim();
  if (isWeightSpaceSetup(draft)) {
    const setup = draft.weightSpace;
    const managed = draft.values.destination === "OpenPond Managed" ? setup?.managed : undefined;
    const details = {
      checkpoint: managed?.checkpoint ? { source: "managed", ...managed.checkpoint } : WEIGHT_SPACE_CHECKPOINT,
      panels: setup?.panels?.map(panel => ({ ...panel, source: null })),
      frozenEvaluation: managed?.frozenEvaluation ?? null,
      generation: { ...weightSpaceGeneration,
        maxOutputTokens: setup?.generation?.maxOutputTokens ?? weightSpaceGeneration.maxOutputTokens,
        seed: setup?.generation?.seed ?? weightSpaceGeneration.seed },
      limits: setup?.limits,
      maximumSpendUsd: setup?.maximumSpendUsd || undefined,
    };
    const review = managed?.checkpoint
      ? "Use the existing OpenPond Weight-space workflow in the selected workspace. Check the exact checkpoint capability, show me the proposed editing plan and cost, and keep the preparation receipt in this chat. Ask for approval before starting the editing session."
      : "Help me review the proposed editing plan. Resolve any missing inputs with me before preparing a managed session and ask for approval before starting it.";
    return [prompt, `Editing setup ${JSON.stringify(details)}.`, review, execution].filter(Boolean).join(" ");
  }
  const { split, epochs, learningRate, budget, samples, seed } = draft.values;
  const method = resourceSetupTrainingMethod(draft);
  const managedMethod = resourceSetupManagedTrainingMethod(draft);
  const managed = draft.values.destination === "OpenPond Managed" ? draft.managedTrainingInputs : undefined;
  const savedStart = resourceSetupSavedTrainingStart(draft);
  const recipe = selectedTrainingRecipe(draft, method);
  const managedBase = savedStart?.base ?? (draft.values.destination === "OpenPond Managed" && managedMethod === "decision_model"
    ? decisionSourcePreference() : managed?.base?.preference);
  const localBase = localTrainingBase(draft)?.preference;
  const version = draft.managedBenchmarkVersions?.candidate ?? draft.benchmarkModelVersion;
  const baseline = draft.comparison ? draft.managedBenchmarkVersions?.baseline : undefined;
  const release = draft.managedBenchmarkDataset?.release;
  const protocol = draft.values.destination === "OpenPond Managed" ? draft.managedBenchmarkProtocol : undefined;
  const settings = [
    release && `Released Dataset ${release.id}, revision ${release.revision}, content hash ${release.contentHash}`,
    draft.managedBenchmarkDataset?.graders?.length && `Released Graders ${JSON.stringify(draft.managedBenchmarkDataset.graders)}`,
    draft.values.outputTokens !== undefined && `maximum output ${draft.values.outputTokens} tokens per task`,
    protocol?.environmentSeeds?.trim() && `environment seeds ${protocol.environmentSeeds.trim()}`,
    protocol?.sampling && `temperature ${protocol.sampling.temperature ?? "unset"}, top P ${protocol.sampling.topP ?? "unset"}`,
    version?.location === "cloud" && `Managed Model ${version.modelProjectId}, training run ${version.jobId}, version hash ${version.versionHash}`,
    baseline && `Managed baseline ${baseline.modelProjectId}, training run ${baseline.jobId}, version hash ${baseline.versionHash}`,
    !draft.datasetInputsDirty && draft.datasetRef && `Dataset ID ${draft.datasetRef.id}, revision ${draft.datasetRef.revision}${draft.datasetRef.contentHash ? `, content hash ${draft.datasetRef.contentHash}` : ""}`,
    managedBase && `Starting model ${managedBase.modelId}, revision ${managedBase.revision}, tokenizer revision ${managedBase.tokenizerRevision}, chat template hash ${managedBase.chatTemplateHash}`,
    savedStart && `Saved starting Model ${savedStart.modelProjectId}, exact version ${savedStart.versionHash}${savedStart.method === "grpo" ? `, training run ${savedStart.jobId}, LoRA continuation ${savedStart.adapterMode}` : ""}`,
    localBase && `Local starting model ${localBase.modelId}, revision ${localBase.revision}, tokenizer revision ${localBase.tokenizerRevision}, chat template hash ${localBase.chatTemplateHash}`,
    draft.localSftApproval && `Approved local SFT review ${draft.localSftApproval.planHash}, Dataset package ${draft.localSftApproval.datasetPackageHash}, training population ${draft.localSftApproval.taskIdsHash}, ${draft.localSftApproval.rowCount} examples`,
    managed?.batch && managedMethod === managed.batch.method && `Reviewed training batch ${managed.batch.reference.id}, revision ${managed.batch.reference.revision}, content hash ${managed.batch.reference.contentHash}`,
    managedMethod === "decision_model" && draft.decisionTraining && `Decision training settings ${canonicalJson(draft.decisionTraining)}`,
    method && managed?.validation && `Validation Dataset ${managed.validation.id}, revision ${managed.validation.revision}, content hash ${managed.validation.contentHash}, split ${managed.validationSplit ?? "validation"}`,
    draft.candidateRef && `Model project ${draft.candidateRef.projectId}, version ${draft.candidateRef.versionId}, artifact ${draft.candidateRef.artifactId}, bundle hash ${draft.candidateRef.bundleHash}`,
    version?.location === "local" && `Model project ${version.projectId}, version ${version.versionId}, artifact ${version.artifactId}, bundle hash ${version.bundleHash}`,
    draft.localBenchmarkInference?.baseline && `Baseline Model project ${draft.localBenchmarkInference.baseline.projectId}, version ${draft.localBenchmarkInference.baseline.versionId}, artifact ${draft.localBenchmarkInference.baseline.artifactId}, bundle hash ${draft.localBenchmarkInference.baseline.bundleHash}`,
    draft.localBenchmarkInference && `Maximum output ${draft.localBenchmarkInference.maxOutputTokens} tokens per case`,
    draft.managedGrader?.release && `Saved Grader ${draft.managedGrader.release.id}, revision ${draft.managedGrader.release.revision}, content hash ${draft.managedGrader.release.contentHash}`,
    version?.location === "cloud" && `Saved Model ${version.modelProjectId}, exact version hash ${version.versionHash}`,
    draft.values.destination === "This device" && draft.localCandidate && `Candidate local provider custom-openai-compatible, model ID ${draft.localCandidate.modelId}, configuration hash ${draft.localCandidate.configurationHash}`,
    draft.values.destination === "This device" && draft.comparison && draft.localBaseline && `Baseline local provider custom-openai-compatible, model ID ${draft.localBaseline.modelId}, configuration hash ${draft.localBaseline.configurationHash}`,
    (draft.localSftApproval || split) && `Dataset split ${draft.localSftApproval ? "train" : split}`,
    method && epochs !== undefined && `${epochs} epochs`,
    method && learningRate !== undefined && `learning rate ${learningRate}`,
    draft.kind === "model" && budget !== undefined && `maximum spend $${budget}`,
    samples !== undefined && `${samples} samples`,
    seed !== undefined && `seed ${seed}`,
  ].filter(Boolean);
  const review = {
    model: "Show me the proposed setup and ask for approval before running it.",
    benchmark: "Show me the proposed setup and ask for approval before running it.",
    dataset: "Show me the field mapping and sample rows, then ask before saving or publishing.",
    grader: "Check passing and failing fixtures. Review any fixture-check cost before running it, and ask before saving or publishing. Keep earlier dataset revisions and run inputs intact.",
    chat: "",
  }[draft.kind];
  const recipeText = recipe ? `Use these training settings ${JSON.stringify(recipe)}.` : "";
  const systemInstructions = protocol?.systemInstructions?.trim()
    ? `Use these system instructions for the evaluated models ${JSON.stringify(protocol.systemInstructions)}.` : "";
  return [prompt, settings.length ? `Use ${settings.join(", ")}.` : "", systemInstructions, recipeText, review, execution].filter(Boolean).join(" ");
}

export function snapshotResourceSetup(
  original: ResourceSetupDraft,
  selection: ChatContextSelection | null,
  instructions: string,
  workspace: ModelSetupScope | null,
  sessionId?: string | null,
) {
  const scoped = scopeManagedSetup(original, workspace, selection, sessionId);
  const draft = { ...scoped, localSftApproval: retainedLocalSftApproval(original, sessionId),
    ...(scoped.kind === "benchmark" && !scoped.comparison ? {
      localBaseline: undefined,
      managedBenchmarkVersions: scoped.managedBenchmarkVersions && { candidate: scoped.managedBenchmarkVersions.candidate },
      localBenchmarkInference: scoped.localBenchmarkInference && { ...scoped.localBenchmarkInference, baseline: undefined },
      values: { ...scoped.values, baseline: undefined },
    } : {}),
  };
  const benchmarkDefinition = draft.kind === "benchmark" && selection?.target.sessionId === sessionId && selection?.localDraft &&
    selection.draft && selection.draftRevision &&
    (selection.benchmarkVersion?.location !== "cloud" || ownsHostedBenchmarkVersion(selection.benchmarkVersion, workspace))
    ? { id: selection.draft.id, revision: selection.draftRevision } : undefined;
  const { datasetExamples: _localExamples, graderExamples: _localFixtures, managedGrader, datasetInputsDirty, trainingRecipes: _recipes,
    weightSpace, managedTrainingInputs, ...setup } = draft;
  const method = resourceSetupTrainingMethod(draft);
  const selectedRecipe = selectedTrainingRecipe(draft, method);
  return {
    prompt: [resourceSetupText(draft), instructions].filter(Boolean).join("\n\n"),
    draft: { ...setup, localTrainingBase: localTrainingBase(draft),
      ...(managedTrainingInputs ? { managedTrainingInputs: { ...managedTrainingInputs,
        savedStarts: draft.values.method === "GRPO" ? { grpo: managedTrainingInputs.savedStarts?.grpo }
          : draft.values.method === "Decision" ? { decision_model: managedTrainingInputs.savedStarts?.decision_model } : undefined,
      } } : {}),
      ...(isWeightSpaceSetup(draft) && weightSpace ? { weightSpace } : {}),
      ...(managedGrader?.release ? { managedGrader: { ...managedGrader, draft: undefined } } : {}),
      ...(method && selectedRecipe ? { trainingRecipes: { [method]: selectedRecipe } } : {}),
      ...(datasetInputsDirty ? { datasetRef: undefined } : {}), ...(benchmarkDefinition ? { benchmarkDefinition } : {}) },
  };
}
