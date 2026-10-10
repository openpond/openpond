import { contentHash } from "@openpond/harness";
import { PreparedTaskProvenanceSchema } from "./dataset-preparation-contracts.js";
import { TaskDesignProposalSchema } from "./task-design-contracts.js";
import { TasksetSourceRefSchema, TaskDataRecordSchema } from "./taskset-draft-core.js";
import { TasksetDraftSchema } from "./taskset-draft-document.js";
import { createTasksetDraft } from "./taskset-draft-authoring.js";
import { createTasksetDraftWorkspace } from "./taskset-draft-workspace.js";
import { createTasksetDraftFile, decodeTasksetDraftFileContent } from "./taskset-draft-files.js";
import type { PreparedTaskProvenance } from "./dataset-preparation-contracts.js";
import type { TaskDesignProposal } from "./task-design-contracts.js";
import type { TasksetSourceRef } from "./taskset-draft-core.js";

/** This creates a private, unqualified draft. Publication and execution stay
 * with their existing owners; no authorer can replace the reconstructed input. */
export function createPreparedTaskAuthoringWorkspace(input: {
  teamId: string;
  provenance: PreparedTaskProvenance;
  initialInput: Record<string, unknown>;
  initialEnvironment: Record<string, unknown>;
  proposal: TaskDesignProposal;
  sources: TasksetSourceRef[];
  skillHash: string;
  modelId: string;
  attempt: number;
  createdAt: string;
}) {
  const provenance = PreparedTaskProvenanceSchema.parse(input.provenance);
  const proposal = TaskDesignProposalSchema.parse(input.proposal);
  const sources = input.sources.map((source) => TasksetSourceRefSchema.parse(source));
  const environment = TasksetDraftSchema.shape.environment.parse(input.initialEnvironment);
  if (contentHash(input.initialInput) !== provenance.initialInputHash || contentHash(environment) !== provenance.initialEnvironmentHash)
    throw new Error("Prepared Taskset input or starting environment differs from its reconstruction.");
  if (environment.kind !== "chat" || environment.stateful || environment.toolNames.length || (environment.resources?.length ?? 0)
    || proposal.taskKind !== "chat" || proposal.diagnosis.requiredTools.length)
    throw new Error("Text preparation cannot silently add tools, state or starting assets.");
  const sourceIds = new Set(sources.map((source) => source.id));
  if (!sources.length || sourceIds.size !== sources.length || proposal.sourceIds.some((id) => !sourceIds.has(id))
    || proposal.proposedExamples.length !== 1 || proposal.proposedExamples.some((example) => !sourceIds.has(example.sourceId)))
    throw new Error("Prepared Taskset authoring must retain exactly one reconstructed task and its authorized evidence.");
  if (!/^[a-f0-9]{64}$/.test(input.skillHash) || !input.modelId.trim() || !Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 6)
    throw new Error("Prepared Taskset authoring provenance is invalid.");
  if (!proposal.proposedGraders.length || new Set(proposal.proposedGraders.map((grader) => grader.id)).size !== proposal.proposedGraders.length)
    throw new Error("Prepared Taskset needs distinct outcome graders.");
  if (proposal.generatedFiles.some((file) => file.role === "environment"))
    throw new Error("Generated code cannot replace the fixed initial text environment.");
  if (proposal.graderFixtures.some((fixture) => fixture.taskIndex !== 0 || fixture.metadata.substituteExpectedOutput === true))
    throw new Error("Prepared fixtures cannot refer to another task or substitute a historical answer.");
  const draft = createTasksetDraft({ profileId: input.teamId,
    id: `${provenance.candidateId}-attempt-${input.attempt}-draft`, name: proposal.name, now: input.createdAt });
  draft.objective = proposal.objective;
  draft.sourceRefs = sources;
  draft.environment = environment;
  draft.graders = proposal.proposedGraders.map((grader) => ({ ...grader, privileged: true,
    ...(grader.kind === "model_judge" ? { rewardEligible: false, calibrationStatus: "pending" as const } : {}),
    metadata: { ...grader.metadata, preparedTask: provenance.candidateId, authoringSkillHash: input.skillHash },
  }));
  draft.policy = { policyVisibleFields: ["input"], privilegedFields: ["expectedOutput"],
    hiddenGraderRefs: draft.graders.map((grader) => grader.id), connectedAppScopes: [] };
  draft.tasks = [TaskDataRecordSchema.parse({ schemaVersion: "openpond.taskData.v1", id: provenance.candidateId,
    clusterKey: provenance.familyKey, split: "validation", input: input.initialInput, expectedOutput: null,
    policyVisibleContext: {}, privilegedContextRef: null, sourceRefs: [...sourceIds],
    tags: ["prepared-task", "development-exposed"], metadata: { preparedTask: provenance, qualificationStatus: "pending" },
  })];
  draft.graderFixtures = proposal.graderFixtures.map(({ taskIndex: _index, ...fixture }) => ({ ...fixture, taskId: provenance.candidateId,
    metadata: { ...fixture.metadata, witnessOrigin: "authoring_proposal", independentlyQualified: false } }));
  draft.metadata = { datasetPreparation: { schemaVersion: "openpond.datasetPreparationAuthoring.v1",
    provenance, modelId: input.modelId, skillHash: input.skillHash, proposalHash: contentHash(proposal),
    attempt: input.attempt, qualification: "pending", exposure: "development" } };
  return createTasksetDraftWorkspace({ schemaVersion: "openpond.tasksetDraftWorkspace.v1", draft,
    files: proposal.generatedFiles.map((generated) => {
      const file = createTasksetDraftFile(generated.path, new TextEncoder().encode(generated.content));
      return { path: file.path, contentHash: file.contentHash, sizeBytes: file.sizeBytes,
        base64: Buffer.from(decodeTasksetDraftFileContent(file.content)).toString("base64") };
    }) });
}
