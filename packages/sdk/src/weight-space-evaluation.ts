import { textTaskPolicyMessages } from "./taskset-text-policy.js";
import { canonicalJson, OpenPondProtocolError } from "./protocol.js";
import { resolveTasksetPackageInstructions, validateTasksetPackage } from "./taskset-package-contracts.js";
import { WeightSpaceFrozenPanelSchema, WeightSpacePanelSchema, type WeightSpaceRequest } from "./weight-space-programming.js";

/** Resolve a policy-visible panel from an already authorized immutable package.
 * Hosts must authorize the exact release again before dispatch and scoring.
 * The returned envelope contains no answers, graders or private context. */
export function resolveWeightSpaceTasksetPanel(raw: unknown, input: {
  source: NonNullable<WeightSpaceRequest["frozenEvaluation"]>;
  role: "development" | "preservation" | "frozen";
  taskIds?: string[];
}) {
  const value = validateTasksetPackage(raw), release = value.taskset;
  const source = { id: release.id, revision: release.revision, contentHash: release.contentHash };
  if (canonicalJson(source) !== canonicalJson(input.source)
    || !["openpond.text.v1", "openpond-chat-v1"].includes(release.environment.entrypoint)
    || release.environment.kind !== "text" || release.environment.stateful || release.tools.length
    || value.modelResources?.taskDefinition.harness || !value.modelResources && release.metadata.learning !== undefined)
    throw new OpenPondProtocolError("weight_space_dataset_unavailable", "Select an exact executable text Dataset without tools or an environment harness.");
  const ids = input.taskIds ?? (input.role === "frozen"
    ? release.tasks.filter(task => task.split === "frozen_eval").map(task => task.id) : []);
  if (!ids.length || ids.length > 64 || new Set(ids).size !== ids.length)
    throw new OpenPondProtocolError("weight_space_dataset_population", "Select one to 64 distinct tasks for the evaluation panel.");
  const instructions = resolveTasksetPackageInstructions(value);
  const prompts = ids.map(id => {
    const task = release.tasks.find(task => task.id === id);
    if (!task || (task.split === "frozen_eval") !== (input.role === "frozen")
      || task.input.connectedEvidenceRef !== undefined || task.requiredOutputs?.length
      || task.artifactRefs.length || task.privilegedContextRef)
      throw new OpenPondProtocolError("weight_space_dataset_population", "The selected task is outside the panel's declared text evaluation boundary.");
    const [system, user] = textTaskPolicyMessages(task, instructions);
    return { id, text: user!.text, system: system!.text };
  });
  const panel = input.role === "frozen" ? WeightSpaceFrozenPanelSchema.parse({ source, prompts })
    : WeightSpacePanelSchema.parse({ id: source.id, source, role: input.role, prompts });
  return { package: value, panel };
}
