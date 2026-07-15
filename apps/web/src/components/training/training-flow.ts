import type { AppPreferences, ChatModelRef, CodexReasoningEffort, TaskCreationRequest, TaskCreationSnapshot, TaskMinerRun, TrainingStateResponse } from "@openpond/contracts";
import type { useTraining } from "../../hooks/useTraining";

type TrainingController = ReturnType<typeof useTraining>;

export type NewModelStep =
  | "start"
  | "automatic_scope"
  | "automatic_candidates"
  | "manual_goal"
  | "evidence"
  | "recommendation";

export function shouldRevealMinerCandidates(step: NewModelStep, run: TaskMinerRun | null): run is TaskMinerRun {
  return step === "automatic_scope" && run?.status === "succeeded";
}

export function trainingAuthoringModel(
  preferences: AppPreferences["training"],
  fallbackModel: ChatModelRef,
): ChatModelRef {
  return preferences.defaultModelRef ?? fallbackModel;
}

export async function startConfiguredTaskCreation(input: {
  training: TrainingController;
  sourceIds: string[];
  objective?: string | null;
  methodHint?: TaskCreationRequest["methodHint"];
  surface: "slash_train" | "training_page";
  preferences: AppPreferences["training"];
  fallbackModel: ChatModelRef;
  analysisModel?: ChatModelRef;
  reasoningEffort: CodexReasoningEffort;
  mode?: "defaults" | "customize";
}): Promise<TaskCreationSnapshot | null> {
  const creation = await input.training.actions.startCreation(input.sourceIds, {
    surface: input.surface,
    mode: input.mode ?? input.preferences.creationMode,
    objective: input.objective?.trim() || undefined,
    methodHint: input.methodHint ?? null,
    analysisModel: input.analysisModel ?? trainingAuthoringModel(input.preferences, input.fallbackModel),
    analysisReasoningEffort: input.reasoningEffort,
  });
  if (
    creation?.state === "awaiting_disclosure_approval" &&
    input.preferences.autoApproveEvidence
  ) {
    return input.training.actions.approveDisclosure(creation.id, true);
  }
  return creation;
}

export function trainingCreationForSession(
  state: TrainingStateResponse | null | undefined,
  sessionId: string | null | undefined,
): TaskCreationSnapshot | null {
  if (!state || !sessionId) return null;
  const sourceIds = new Set(
    state.sources.filter((source) => source.sessionId === sessionId).map((source) => source.id),
  );
  if (!sourceIds.size) return null;
  return state.creations.find((creation) =>
    creation.request.sourceIds.some((sourceId) => sourceIds.has(sourceId))) ?? null;
}
