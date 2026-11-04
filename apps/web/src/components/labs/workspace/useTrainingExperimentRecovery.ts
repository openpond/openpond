import { useQuery } from "@tanstack/react-query";
import {
  TrainingExperimentRecoveryIntentSchema,
  TrainingExperimentControlIntentSchema,
  TrainingExperimentControlCommandSchema,
  type EvaluationOperationRecovery,
} from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import {
  canonicalJson,
  TrainingExperimentSetupRequestSchema,
} from "openpond-sdk/training";
import { connectionQueryScope } from "../../../lib/query-scope";
import type { WorkspaceApi } from "./workspace-api";

export const TRAINING_PREPARATION_ACTION = "training:prepare-draft";
export const TRAINING_CONTROL_ACTION = "training:control-preparation";
type Operation = ReturnType<WorkspaceApi["recoverOperation"]>;
export type RetainedTrainingReview = {
  intent: ReturnType<typeof TrainingExperimentRecoveryIntentSchema.parse>;
  request: ReturnType<typeof TrainingExperimentSetupRequestSchema.parse>;
  operation: Operation;
  snapshot: string;
  acknowledge: Operation["acknowledge"];
};
export type RetainedTrainingControl = {
  intent: ReturnType<typeof TrainingExperimentControlIntentSchema.parse>;
  command: ReturnType<typeof TrainingExperimentControlCommandSchema.parse>;
  operation: Operation;
  phase: EvaluationOperationRecovery["phase"];
};

/** Read-only discovery: reopen never resubmits preparation or paid execution. */
export async function loadTrainingExperimentRecovery(
  api: WorkspaceApi,
  draftId: string,
  method: "sft" | "grpo",
  signal?: AbortSignal,
) {
  async function rows(action: EvaluationOperationRecovery["action"]) {
    const result: EvaluationOperationRecovery[] = [],
      seen = new Set<string>();
    let cursor: string | undefined;
    for (let pageIndex = 0; ; pageIndex++) {
      if (pageIndex >= 100)
        throw new Error(
          "The retained training catalog exceeds its supported bound.",
        );
      const page = await api.pendingOperations(action, cursor, signal);
      result.push(...page.items);
      if (!page.nextCursor) return result;
      if (seen.has(page.nextCursor))
        throw new Error("The retained training catalog repeated a page.");
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }
  const [preparations, controls] = await Promise.all([
    rows(TRAINING_PREPARATION_ACTION),
    rows(TRAINING_CONTROL_ACTION),
  ]);
  const reviews: RetainedTrainingReview[] = [];
  for (const row of preparations) {
    const intent = TrainingExperimentRecoveryIntentSchema.parse(
      row.reviewedIntent,
    );
    if (intent.draftId !== draftId || intent.request.settings.method !== method)
      continue;
    const request = TrainingExperimentSetupRequestSchema.parse({
      ...intent.request,
      operationId: row.id,
    });
    if (
      intent.request.teamId !== api.teamId ||
      intent.request.projectId !== api.projectId ||
      row.intentHash !== contentHash(intent) ||
      (row.command && canonicalJson(row.command) !== canonicalJson(request))
    )
      throw new Error(
        "The retained training preparation changed its exact inputs or workspace.",
      );
    const operation = api.recoverOperation(row);
    reviews.push({
      intent,
      request,
      operation,
      snapshot: canonicalJson(intent.form),
      acknowledge: operation.acknowledge,
    });
  }
  if (reviews.length > 1)
    throw new Error(
      "Resolve the original retained training review before preparing another run.",
    );
  const review = reviews[0] ?? null,
    matches: RetainedTrainingControl[] = [];
  for (const row of controls) {
    const intent = TrainingExperimentControlIntentSchema.parse(
      row.reviewedIntent,
    );
    if (intent.draftId !== draftId || intent.method !== method) continue;
    if (!review || intent.preparationOperationId !== review.request.operationId)
      throw new Error(
        "The retained training control is missing its original preparation. Recover that original review before starting another run.",
      );
    const command = TrainingExperimentControlCommandSchema.parse(
      row.command ?? intent.command,
    );
    if (
      row.intentHash !== contentHash(intent) ||
      canonicalJson(command) !== canonicalJson(intent.command) ||
      intent.receipt.plan.creatorUserId !== api.actorId ||
      intent.receipt.plan.request.teamId !== api.teamId ||
      intent.receipt.plan.request.projectId !== api.projectId
    )
      throw new Error(
        "The retained training control changed its creator, plan or estimate approval.",
      );
    matches.push({
      intent,
      command,
      operation: api.recoverOperation(row),
      phase: row.phase,
    });
  }
  if (matches.length > 1)
    throw new Error(
      "Recover the original training control before submitting another action.",
    );
  return { review, control: matches[0] ?? null };
}

export function useTrainingExperimentRecovery(
  api: WorkspaceApi,
  draftId: string | undefined,
  method: "sft" | "grpo",
  enabled: boolean,
) {
  return useQuery({
    queryKey: [
      "training-experiment-recovery",
      api.key,
      connectionQueryScope(api.connection),
      draftId,
      method,
    ],
    enabled: enabled && Boolean(draftId && api.actorId),
    queryFn: ({ signal }) =>
      loadTrainingExperimentRecovery(api, draftId!, method, signal),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}
