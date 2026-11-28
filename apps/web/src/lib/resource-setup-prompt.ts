import { z } from "zod";

const fieldText = z.string().max(2_000).optional();
const positiveInteger = z.number().int().positive().optional();
const nonnegativeNumber = z.number().nonnegative().optional();
const valuesSchema = z.object({
  name: fieldText,
  objective: fieldText,
  baseModel: fieldText,
  candidate: fieldText,
  baseline: fieldText,
  dataset: fieldText,
  datasetRevision: positiveInteger,
  split: fieldText,
  grader: fieldText,
  method: z.enum(["SFT", "GRPO", "Decision", "Weight-space programming"]).optional(),
  adapter: z.enum(["LoRA", "Full fine-tuning"]).optional(),
  learning: z.enum(["One-time training", "Configure continual learning"]).optional(),
  destination: z.enum(["This device", "OpenPond Managed"]).optional(),
  source: z.enum(["Write examples", "Import a local file", "Use an existing dataset"]).optional(),
  graderType: z.enum(["Code grader", "LLM judge", "Human assessment", "Python correctness"]).optional(),
  fields: fieldText,
  samples: positiveInteger,
  epochs: positiveInteger,
  learningRate: nonnegativeNumber,
  seed: z.number().int().nonnegative().optional(),
  budget: nonnegativeNumber,
  criterion: fieldText,
  cases: fieldText,
  project: fieldText,
});

export const ResourceSetupDraftSchema = z.object({
  kind: z.enum(["chat", "model", "benchmark", "dataset", "grader"]),
  revision: z.number().int().positive(),
  comparison: z.boolean().optional(),
  candidateRef: z.object({
    projectId: z.string().min(1).max(240),
    versionId: z.string().min(1).max(240),
    artifactId: z.string().min(1).max(240),
    bundleHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
  datasetRef: z.object({
    id: z.string().min(1).max(240),
    revision: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).optional(),
  values: valuesSchema,
});
export type ResourceSetupDraft = z.infer<typeof ResourceSetupDraftSchema>;
export type ResourceSetupField = keyof ResourceSetupDraft["values"];
export type ResourceSetupMethod = ResourceSetupDraft["values"]["method"];
export type ResourceSetupCandidate = NonNullable<ResourceSetupDraft["candidateRef"]> & { label: string };

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
      return ["Set up ", name, " from ", field("source", "Choose a source"), " with ",
        field("fields", "Choose input and expected output fields"), ". Show me ",
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
  if (field === "trainingSettings" || field === "evaluationSettings" || field === "preview") return placeholder;
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
  const settings = [
    draft.datasetRef && `Dataset ID ${draft.datasetRef.id}, revision ${draft.datasetRef.revision}${draft.datasetRef.contentHash ? `, content hash ${draft.datasetRef.contentHash}` : ""}`,
    draft.candidateRef && `Model project ${draft.candidateRef.projectId}, version ${draft.candidateRef.versionId}, artifact ${draft.candidateRef.artifactId}, bundle hash ${draft.candidateRef.bundleHash}`,
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
  return [prompt, settings.length ? `Use ${settings.join(", ")}.` : "", review, execution].filter(Boolean).join(" ");
}
