import {
  ExperimentDraftSchema,
  ExperimentDraftRecordSchema,
  StoredExperimentResultReferenceSchema,
  TrainingResultSchema,
  ManagedModificationExecutionSchema,
  ManagedEngramExecutionSchema,
  ManagedDecisionExecutionSchema,
  ManagedAlphaEditExecutionSchema,
  ManagedNeuronTrainingExecutionSchema,
  canonicalJson,
} from "openpond-sdk/training";
import { z } from "zod";
import { ChatResourceSummarySchema } from "./chat-resources.js";
import { ChatTrainingAttachmentSchema } from "./chat-training-resources.js";

const ContextResultReferenceSchema = StoredExperimentResultReferenceSchema;
const resultKinds = new Set(["training_result", "managed_modification_result", "engram_result",
  "decision_result", "alphaedit_result", "neuron_training_result"]);

export const ChatContextTargetSchema = z
  .object({
    kind: z.enum([
      "dataset",
      "experiment",
      "model",
      "training",
      "training_result",
      "managed_modification_result",
      "engram_result",
      "decision_result",
      "alphaedit_result",
      "neuron_training_result",
    ]),
    id: z.string().trim().min(1).max(240),
    draft: ExperimentDraftSchema.optional(),
    storedDraft: z.literal(true).optional(),
    revision: z.number().int().positive().optional(),
    location: z.enum(["local", "cloud"]).default("local"),
    teamId: z.string().min(1).max(240).optional(),
    apiOrigin: z.url().max(2000).optional(),
    scopeId: z.string().min(1).max(240).optional(),
    sessionId: z.string().min(1).max(240).optional(),
    result: ContextResultReferenceSchema.optional(),
  })
  .strict()
  .superRefine((target, context) => {
    if (
      resultKinds.has(target.kind)
        ? !target.result ||
          target.result.kind !== target.kind ||
          target.location !== "cloud" ||
          target.id !== (target.result.kind === "training_result" ? target.result.jobId : target.result.executionId) ||
          target.teamId !== target.result.owner.teamId ||
          target.apiOrigin !== target.result.apiOrigin ||
          target.draft ||
          target.storedDraft ||
          target.revision ||
          target.scopeId ||
          target.sessionId
        : target.result !== undefined
    )
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "Retain the exact completed result in its original hosted account.",
      });
    if (
      target.draft &&
      (target.kind !== "experiment" ||
        target.id !== target.draft.id ||
        target.location !== "local" ||
        target.scopeId ||
        target.sessionId ||
        target.revision ||
        target.teamId ||
        target.apiOrigin ||
        target.storedDraft)
    )
      context.addIssue({
        code: "custom",
        path: ["draft"],
        message: "An unsaved draft requires its own local experiment identity.",
      });
    if (
      target.storedDraft &&
      (target.kind !== "experiment" ||
        target.location !== "cloud" ||
        !target.teamId ||
        !target.apiOrigin ||
        target.scopeId ||
        target.sessionId ||
        target.revision)
    )
      context.addIssue({
        code: "custom",
        path: ["storedDraft"],
        message: "A stored experiment requires its canonical account reference.",
      });
  });
export const ChatContextOptionSchema = z
  .object({
    target: ChatContextTargetSchema,
    label: z.string().max(500),
    detail: z.string().max(2000),
  })
  .strict();
export const ChatContextSelectionSchema = ChatContextOptionSchema.extend({
  draft: ExperimentDraftSchema.optional(),
  draftRevision: z.number().int().positive().optional(),
  storedDraft: ExperimentDraftRecordSchema.optional(),
  resource: ChatResourceSummarySchema.optional(),
  dataset: ChatResourceSummarySchema.optional(),
  graders: z.array(ChatResourceSummarySchema).optional(),
  training: ChatTrainingAttachmentSchema.optional(),
  results: z.array(ContextResultReferenceSchema).max(1).optional(),
  trainingResult: TrainingResultSchema.optional(),
  managedModificationResult: ManagedModificationExecutionSchema.optional(),
  engramResult: ManagedEngramExecutionSchema.optional(),
  decisionResult: ManagedDecisionExecutionSchema.optional(),
  alphaEditResult: ManagedAlphaEditExecutionSchema.optional(),
  neuronTrainingResult: ManagedNeuronTrainingExecutionSchema.optional(),
  model: z
    .object({
      id: z.string(),
      name: z.string(),
      portableProjectId: z.string(),
      baseModel: z.string().nullable(),
      trainingDataset: z
        .object({ id: z.string(), revision: z.number().int().positive(), name: z.string() })
        .nullable(),
      evaluationDataset: z
        .object({ id: z.string(), revision: z.number().int().positive(), name: z.string() })
        .nullable(),
    })
    .strict()
    .optional(),
})
  .strict()
  .superRefine((selection, context) => {
    const kind = selection.target.kind,
      pin = selection.target.result;
    const execution =
      kind === "decision_result"
        ? selection.decisionResult
        : kind === "alphaedit_result"
          ? selection.alphaEditResult
          : kind === "neuron_training_result"
            ? selection.neuronTrainingResult
            : undefined;
    const evidence = [
      selection.trainingResult,
      selection.managedModificationResult,
      selection.engramResult,
      selection.decisionResult,
      selection.alphaEditResult,
      selection.neuronTrainingResult,
    ].filter((value) => value !== undefined);
    if (!resultKinds.has(kind)) {
      if (evidence.length || selection.results !== undefined)
        context.addIssue({
          code: "custom",
          message: "Retained results require their exact result selection.",
        });
      return;
    }
    const retained = selection.results?.[0];
    const mismatch = () => context.addIssue({ code: "custom", message: "The selected evidence differs from its exact completed result." });
    if (!pin || !retained || canonicalJson(retained) !== canonicalJson(pin) || evidence.length !== 1) {
      mismatch(); return;
    }
    if (pin.kind === "training_result") {
      const value = selection.trainingResult, candidate = value?.candidate;
      const immutableCandidate = candidate ? { artifact: candidate.artifact, checkpointId: candidate.checkpointId,
        composition: candidate.composition, parent: candidate.parent } : null;
      if (kind !== pin.kind || !value || value.candidateState !== "retained" || !candidate ||
        value.job.id !== pin.jobId || value.teamId !== pin.owner.teamId || value.job.modelProjectId !== pin.modelProjectId ||
        value.job.portableProjectId !== pin.portableProjectId || value.job.submissionHash !== pin.submissionHash ||
        canonicalJson(immutableCandidate) !== canonicalJson(pin.candidate) ||
        !value.outputs.receipt || value.outputs.receipt.id !== pin.executionReceipt.id ||
        !value.outputs.outputs.some(output => output.kind === "receipt" &&
          output.id === `${value.outputs.receipt!.id}:output` && output.contentHash === pin.executionReceipt.contentHash)) mismatch();
      return;
    }
    if (pin.kind === "managed_modification_result" || pin.kind === "engram_result") {
      const value = pin.kind === "engram_result" ? selection.engramResult : selection.managedModificationResult;
      if (kind !== pin.kind || !value || value.phase !== "completed" || !value.result ||
        value.id !== pin.executionId || value.teamId !== pin.owner.teamId || value.ownerUserId !== pin.owner.actorId ||
        value.projectId !== pin.projectId || value.plan.inputHash !== pin.inputHash ||
        value.plan.runtimeHash !== pin.runtimeHash || value.result.contentHash !== pin.resultHash ||
        (pin.kind === "managed_modification_result" && (value.method !== pin.method || !selection.managedModificationResult)) ||
        (pin.kind === "engram_result" && (!selection.engramResult ||
          canonicalJson({ id: selection.engramResult.result?.artifact.id, contentHash: selection.engramResult.result?.artifact.contentHash }) !== canonicalJson(pin.artifact)))) mismatch();
      return;
    }
    const result = execution?.result;
    if (
      !pin ||
      pin.kind !== kind ||
      !retained ||
      evidence.length !== 1 ||
      !execution ||
      !result ||
      execution.phase !== "completed" ||
      execution.id !== pin.executionId ||
      execution.teamId !== pin.owner.teamId ||
      execution.ownerUserId !== pin.owner.actorId ||
      execution.projectId !== pin.projectId ||
      execution.plan.inputHash !== pin.inputHash ||
      result.modelHash !== pin.modelHash ||
      result.runtimeHash !== pin.runtimeHash ||
      result.contentHash !== pin.resultHash ||
      canonicalJson(retained) !== canonicalJson(pin) ||
      (execution.schemaVersion === "openpond.managedDecisionExecution.v1" &&
        (pin.kind !== "decision_result" || execution.mode !== pin.mode)) ||
      canonicalJson(
        result.artifact
          ? { id: result.artifact.id, contentHash: result.artifact.contentHash }
          : null,
      ) !== canonicalJson(pin.artifact)
    )
      context.addIssue({
        code: "custom",
        message: "The selected evidence differs from its exact completed result.",
      });
  });
export type ChatContextTarget = z.infer<typeof ChatContextTargetSchema>;
export type ChatContextOption = z.infer<typeof ChatContextOptionSchema>;
export type ChatContextSelection = z.infer<typeof ChatContextSelectionSchema>;
