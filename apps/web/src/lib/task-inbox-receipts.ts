import type { TaskInboxSnapshot, TaskInput } from "@openpond/contracts";

/** Publish acceptance immediately, including before the first inbox GET finishes. */
export function taskInboxWithReceipt(
  current: TaskInboxSnapshot | undefined,
  sessionId: string,
  receipt: TaskInput,
): TaskInboxSnapshot {
  const snapshot = current ?? { sessionId, activeTurnId: null, acceptingInput: false, paused: false, inputs: [], waits: [] };
  const previous = snapshot.inputs.find(input => input.id === receipt.id);
  if (previous && (previous.revision > receipt.revision
    || (previous.revision === receipt.revision && previous.updatedAt > receipt.updatedAt))) return snapshot;
  return { ...snapshot, inputs: [...snapshot.inputs.filter(input => input.id !== receipt.id), receipt].sort((a, b) => a.sequence - b.sequence) };
}
