import type { TaskCreationSnapshot } from "@openpond/contracts";

const TERMINAL_CREATION_STATES = new Set<TaskCreationSnapshot["state"]>([
  "cancelled",
  "failed",
  "ready",
]);

export function shouldCancelCreationOnDialogDismiss(
  creation: TaskCreationSnapshot | null,
): creation is TaskCreationSnapshot {
  return Boolean(creation && !TERMINAL_CREATION_STATES.has(creation.state));
}
