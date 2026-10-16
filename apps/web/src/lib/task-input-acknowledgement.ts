import type { TaskInput } from "@openpond/contracts";

/** Recover a lost HTTP acknowledgement only from the exact durable user intent. */
export function retainedTaskInputAcknowledgement(inputs: readonly TaskInput[], intent: {key: string; body: string; kind: string} | null): TaskInput | null {
  return intent ? inputs.find(input => input.idempotencyKey === intent.key && input.senderKind === "user" &&
    input.kind === intent.kind && input.body === intent.body && ["pending", "included", "resolved"].includes(input.state)) ?? null : null;
}
