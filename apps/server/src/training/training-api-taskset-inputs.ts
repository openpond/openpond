import type { TaskCreationRequest } from "@openpond/contracts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function managedRolloutPlacement(
  value: unknown,
): "local" | "remote" | undefined {
  return value === "local" || value === "remote" ? value : undefined;
}

export function preferenceDatasetPartition(
  value: unknown,
): "reward_train" | "reward_validation" | "reward_qualification" {
  if (
    value === "reward_train" ||
    value === "reward_validation" ||
    value === "reward_qualification"
  ) {
    return value;
  }
  throw new Error(
    "Preference dataset partition must be reward_train, reward_validation, or reward_qualification.",
  );
}

export function preferenceRatings(
  value: unknown,
): Record<string, "love" | "like" | "reject"> {
  const ratings = record(value);
  return Object.fromEntries(
    Object.entries(ratings).map(([attemptId, rating]) => {
      if (rating !== "love" && rating !== "like" && rating !== "reject") {
        throw new Error(
          `Preference rating for ${attemptId} must be love, like, or reject.`,
        );
      }
      return [attemptId, rating];
    }),
  );
}

export function datasetBuildIntent(
  value: unknown,
): TaskCreationRequest["buildIntent"] {
  return value === "preferences" ||
    value === "verifiable_reward" ||
    value === "rubric" ||
    value === "discovery"
    ? value
    : "demonstrations";
}

export function trainingMethodHint(
  value: unknown,
): TaskCreationRequest["methodHint"] {
  return value === "sft" ||
    value === "dpo" ||
    value === "grpo" ||
    value === "ppo"
    ? value
    : null;
}

export function tasksetTargetIntent(
  value: unknown,
): TaskCreationRequest["targetIntent"] {
  const candidate = record(value);
  const kind = candidate.kind;
  return {
    kind:
      kind === "agent" ||
      kind === "skill" ||
      kind === "extension" ||
      kind === "model" ||
      kind === "configuration"
        ? kind
        : null,
    id: string(candidate.id),
    displayName: string(candidate.displayName),
    operation: candidate.operation === "improve" ? "improve" : "create",
  };
}

export function creationSurface(value: unknown) {
  return value === "session_menu" ||
    value === "bulk_selection" ||
    value === "training_page" ||
    value === "task_candidate"
    ? value
    : "slash_train";
}
