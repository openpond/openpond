import {
  LearningCommandSchema,
  LearningReadRequestSchema,
  LearningResourceKindSchema,
  type LearningCommand,
} from "openpond-sdk/learning";
import type { OpenPondMcpScope, ToolDefinition } from "./types.js";

/** Reviewed training dependency closure. New SDK actions/resources do not enter
 * discovery or the host delegate merely by being added to a canonical union. */
export const TRAINING_LEARNING_ACTIONS = {
  import_intake: "write",
  submit_example: "write",
  submit_feedback: "write",
  apply_correction: "write",
  resolve_feedback: "write",
  queue_grade: "execute",
  review: "review",
  seal_batch: "write",
  cancel_grade: "cancel",
  save_draft: "write",
  archive_draft: "write",
  queue_reward_check: "execute",
  cancel_reward_check: "cancel",
  publish_checked_reward: "publish",
  publish: "publish",
  reserve_iteration: "learning",
  cancel_iteration_reservation: "cancel",
  cancel_iteration: "cancel",
  retry_iteration_dispatch: "learning",
} as const satisfies Partial<Record<LearningCommand["action"], ToolDefinition["effect"]>>;

export const TRAINING_LEARNING_KINDS = [
  "draft",
  "reward_check",
  "asset",
  "definition",
  "reward",
  "binding",
  "source",
  "evidence",
  "feedback",
  "decision",
  "batch",
  "policy",
  "iteration",
  "grade",
  "package",
] as const satisfies readonly (typeof LearningResourceKindSchema.options)[number][];
export const TRAINING_LEARNING_PUBLISH_KINDS = [
  "asset",
  "definition",
  "binding",
  "source",
  "policy",
] as const;

export function trainingLearningCommandScopes(raw: unknown): readonly OpenPondMcpScope[] {
  const command = LearningCommandSchema.parse(raw);
  if (
    !(command.action in TRAINING_LEARNING_ACTIONS) ||
    (command.action === "publish" &&
      !TRAINING_LEARNING_PUBLISH_KINDS.some((kind) => kind === command.kind))
  )
    throw new Error("learning_operation_denied");
  if (command.action === "publish" && command.kind === "policy")
    return ["app:publish", "app:learning"];
  const effect =
    TRAINING_LEARNING_ACTIONS[command.action as keyof typeof TRAINING_LEARNING_ACTIONS];
  return [`app:${effect}`];
}

export function assertTrainingLearningRead(raw: unknown) {
  const read = LearningReadRequestSchema.parse(raw);
  if (
    (read.action === "get" || read.action === "list") &&
    !TRAINING_LEARNING_KINDS.some((kind) => kind === read.kind)
  )
    throw new Error("learning_operation_denied");
  return read;
}
