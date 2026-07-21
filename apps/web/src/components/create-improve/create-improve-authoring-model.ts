import type {
  BaseModelCandidate,
  BaseModelPreference,
  TaskCreationSnapshot,
  TaskMinerConfig,
} from "@openpond/contracts";
import type { NewModelMode } from "../training/TrainingStartModeStep";
import type { NewModelStep } from "../training/training-flow";

export type CreateImproveAuthoringTarget =
  TaskCreationSnapshot["request"]["targetIntent"];

export function initialCreationStep(
  creation: TaskCreationSnapshot | null,
): NewModelStep {
  if (!creation) return "start";
  if (creation.state === "awaiting_disclosure_approval") return "evidence";
  return "recommendation";
}

export function candidateForPreference(
  candidates: BaseModelCandidate[],
  preference: BaseModelPreference | null,
  legacyModelId: string | null,
): BaseModelCandidate | null {
  if (preference) {
    const exact = candidates.find((candidate) =>
      candidate.preference.modelId === preference.modelId
      && candidate.preference.source === preference.source
      && candidate.preference.revision === preference.revision
      && candidate.preference.modelAssetId === preference.modelAssetId);
    if (exact) return exact;
  }
  const modelId = preference?.modelId ?? legacyModelId;
  return modelId
    ? candidates.find((candidate) => candidate.preference.modelId === modelId) ?? null
    : null;
}

export function authoringFailureCopy(reason: string | null): string {
  if (!reason) return "The authoring model did not return a proposal.";
  if (reason.trim().toLowerCase() === "terminated") {
    return "OpenPond Chat closed the Taskset authoring stream before a proposal was returned. No Taskset was created.";
  }
  return reason;
}

export function dialogTitle(
  target: CreateImproveAuthoringTarget,
  resourceIntent: TaskCreationSnapshot["request"]["resourceIntent"],
): string {
  if (resourceIntent === "dataset") return "New Dataset";
  if (target.kind === "agent") {
    return target.operation === "improve"
      ? `Improve ${target.displayName ?? "agent"}`
      : "New agent";
  }
  if (target.kind === "model") return "New model";
  return "New change";
}

export function targetLabel(
  target: CreateImproveAuthoringTarget,
  resourceIntent: TaskCreationSnapshot["request"]["resourceIntent"],
): string {
  if (resourceIntent === "dataset") return "dataset";
  if (target.kind === "agent") return "agent";
  if (target.kind === "model") return "model";
  return "workproduct";
}

export function reviewTitle(
  target: CreateImproveAuthoringTarget,
  resourceIntent: TaskCreationSnapshot["request"]["resourceIntent"],
): string {
  if (resourceIntent === "dataset") return "Review Dataset";
  if (target.kind === "model") return "Review model";
  if (target.kind === "agent") {
    return target.operation === "improve" ? "Review agent change" : "Review agent";
  }
  return "Review change";
}

export function aggregateEstimate(
  sessionIds: string[],
  estimates: Record<string, { messageCount: number; estimatedTokens: number }>,
) {
  let messageCount = 0;
  let estimatedTokens = 0;
  let measuredChats = 0;
  for (const sessionId of sessionIds) {
    const estimate = estimates[sessionId];
    if (!estimate) continue;
    measuredChats += 1;
    messageCount += estimate.messageCount;
    estimatedTokens += estimate.estimatedTokens;
  }
  return { messageCount, estimatedTokens, measuredChats };
}

export function backLabel(
  step: NewModelStep,
  usesBaseModelStep: boolean,
  mode: NewModelMode | null,
): string {
  if (step === "base_model") return "Back to setup";
  if (step === "existing_dataset") return "Back to base model";
  if (step === "automatic_scope") {
    return usesBaseModelStep ? "Back to base model" : "Back to setup";
  }
  if (step === "automatic_candidates") return "Back to scan scope";
  if (step === "evidence") {
    if (mode === "automated") return "Back to repeated workflows";
    return usesBaseModelStep ? "Back to base model" : "Back to setup";
  }
  return "Back to Dataset";
}

export function defaultMinerConfig(): TaskMinerConfig {
  return {
    schemaVersion: "openpond.taskMinerConfig.v1",
    enabled: false,
    localOnly: true,
    observationWindowDays: 30,
    minimumRecurrence: 3,
    clustering: "hybrid_deterministic_first",
    consentRequired: true,
  };
}
