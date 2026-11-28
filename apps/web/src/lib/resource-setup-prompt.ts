import type { BenchmarkModelVersion, ResourceSetupDraft } from "@openpond/contracts/resource-setup";
import type { ChatContextSelection } from "@openpond/contracts";
export { ResourceSetupDraftSchema, type ResourceSetupDraft } from "@openpond/contracts/resource-setup";

export type ResourceSetupField = keyof ResourceSetupDraft["values"];
export type ResourceSetupMethod = ResourceSetupDraft["values"]["method"];
export type ResourceSetupCandidate = BenchmarkModelVersion & { label: string };
export type ModelSetupScope = { accountKey: string; teamId: string | null; actorId: string | null };

export function scopeManagedSetup(draft: ResourceSetupDraft, scope: ModelSetupScope | null) {
  if (draft.benchmarkModelVersion?.location === "cloud" &&
    (draft.benchmarkModelVersion.teamId !== scope?.teamId || !scope?.actorId))
    return { ...draft, benchmarkModelVersion: undefined, values: { ...draft.values, candidate: undefined } };
  const managed = draft.managedTrainingInputs;
  if (!managed || draft.values.destination === "OpenPond Managed" && managed.accountKey === scope?.accountKey &&
    managed.teamId === scope?.teamId && managed.actorId === scope?.actorId) return draft;
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

function localTrainingBase(draft: ResourceSetupDraft) {
  return draft.kind === "model" && draft.values.destination !== "OpenPond Managed" ? draft.localTrainingBase : undefined;
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

export function newResourceSetup(
  kind: ResourceSetupDraft["kind"],
  options: { method?: ResourceSetupMethod; comparison?: boolean } = {},
): ResourceSetupDraft {
  const method = options.method;
  return {
    kind,
    revision: 1,
    ...(options.comparison ? { comparison: true } : {}),
    values: method === "SFT" ? { method, adapter: "LoRA", dataset: "GSM8K", grader: "Exact numeric answer" }
      : method === "GRPO" ? { method, adapter: "LoRA" }
      : method ? { method } : kind === "dataset" ? { destination: "This device" } : {},
  };
}

type PromptField = ResourceSetupField | "trainingSettings" | "evaluationSettings" | "saveDestination" | "preview";
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
      const adapter = method !== "Decision" && method !== "Weight-space programming";
      return [
        "Set up ", name, " for ", objective, " using ", field("baseModel", "Choose a starting model or checkpoint"),
        " with ", field("method", "Choose a training method"),
        ...(adapter ? [" and a ", field("adapter", "Choose an adapter"), " adapter"] : []), ".",
        " Use ", dataset, " with ", field("grader", method === "GRPO" ? "Choose a reward grader" : "Choose a grader"), ".",
        " Show me the plan with ", field("trainingSettings", "Training settings"), " and ",
        field("learning", "Learning settings"), ".", " Run on ", destination, ".",
      ];
    }
    case "benchmark":
      return [
        "Set up ", name, " for ", objective, ". Evaluate ", field("candidate", "Choose a candidate version"),
        ...(draft.comparison ? [" against ", field("baseline", "Choose a baseline version")] : []),
        " on ", dataset, " with ", grader, ". Use ", field("evaluationSettings", "Evaluation protocol"), " and ",
        field("budget", "Choose a budget"), ".", " Run on ", destination, ".",
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
  const localBase = localTrainingBase(draft);
  if (field === "baseModel" && localBase) return localBase.label;
  if (field === "grader" && draft.kind === "benchmark" && draft.values.destination === "This device") return "the Dataset’s local graders";
  const value = draft.values[field];
  if (field === "budget" && typeof value === "number") return `$${value}`;
  if (field === "dataset" && value && draft.values.datasetRevision) return `${value} revision ${draft.values.datasetRevision}`;
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
  const { split, epochs, learningRate, budget, samples, seed } = draft.values;
  const method = resourceSetupTrainingMethod(draft);
  const recipe = selectedTrainingRecipe(draft, method);
  const managed = draft.values.destination === "OpenPond Managed" ? draft.managedTrainingInputs : undefined;
  const localBase = localTrainingBase(draft)?.preference;
  const version = draft.benchmarkModelVersion;
  const settings = [
    !draft.datasetInputsDirty && draft.datasetRef && `Dataset ID ${draft.datasetRef.id}, revision ${draft.datasetRef.revision}${draft.datasetRef.contentHash ? `, content hash ${draft.datasetRef.contentHash}` : ""}`,
    managed?.base && `Starting model ${managed.base.preference.modelId}, revision ${managed.base.preference.revision}, tokenizer revision ${managed.base.preference.tokenizerRevision}, chat template hash ${managed.base.preference.chatTemplateHash}`,
    localBase && `Local starting model ${localBase.modelId}, revision ${localBase.revision}, tokenizer revision ${localBase.tokenizerRevision}, chat template hash ${localBase.chatTemplateHash}`,
    managed?.batch && method === managed.batch.method && `Reviewed training batch ${managed.batch.reference.id}, revision ${managed.batch.reference.revision}, content hash ${managed.batch.reference.contentHash}`,
    managed?.validation && `Validation Dataset ${managed.validation.id}, revision ${managed.validation.revision}, content hash ${managed.validation.contentHash}, split ${managed.validationSplit ?? "validation"}`,
    draft.candidateRef && `Model project ${draft.candidateRef.projectId}, version ${draft.candidateRef.versionId}, artifact ${draft.candidateRef.artifactId}, bundle hash ${draft.candidateRef.bundleHash}`,
    version?.location === "local" && `Model project ${version.projectId}, version ${version.versionId}, artifact ${version.artifactId}, bundle hash ${version.bundleHash}`,
    version?.location === "cloud" && `Saved Model ${version.modelProjectId}, exact version hash ${version.versionHash}`,
    draft.values.destination === "This device" && draft.localCandidate && `Candidate local provider custom-openai-compatible, model ID ${draft.localCandidate.modelId}, configuration hash ${draft.localCandidate.configurationHash}`,
    draft.values.destination === "This device" && draft.comparison && draft.localBaseline && `Baseline local provider custom-openai-compatible, model ID ${draft.localBaseline.modelId}, configuration hash ${draft.localBaseline.configurationHash}`,
    split && `Dataset split ${split}`,
    epochs !== undefined && `${epochs} epochs`,
    learningRate !== undefined && `learning rate ${learningRate}`,
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
  return [prompt, settings.length ? `Use ${settings.join(", ")}.` : "", recipeText, review, execution].filter(Boolean).join(" ");
}

export function snapshotResourceSetup(
  original: ResourceSetupDraft,
  selection: ChatContextSelection | null,
  instructions: string,
  workspace: ModelSetupScope | null,
) {
  const draft = scopeManagedSetup(original, workspace);
  const benchmarkDefinition = draft.kind === "benchmark" && selection?.localDraft && selection.draft && selection.draftRevision
    ? { id: selection.draft.id, revision: selection.draftRevision } : undefined;
  const { datasetExamples: _localExamples, graderExamples: _localFixtures, datasetInputsDirty, trainingRecipes: _recipes, ...setup } = draft;
  const method = resourceSetupTrainingMethod(draft);
  const selectedRecipe = selectedTrainingRecipe(draft, method);
  return {
    prompt: [resourceSetupText(draft), instructions].filter(Boolean).join("\n\n"),
    draft: { ...setup, localTrainingBase: localTrainingBase(draft),
      ...(method && selectedRecipe ? { trainingRecipes: { [method]: selectedRecipe } } : {}),
      ...(datasetInputsDirty ? { datasetRef: undefined } : {}), ...(benchmarkDefinition ? { benchmarkDefinition } : {}) },
  };
}
