import { canonicalHash } from "@openpond/agent-runtime";
import { validateTaskValue } from "@openpond/evals/task-schema";
import type { ProfileWorkflow } from "@openpond/harness";

export function prepareProfileWorkflowTurn(input: {
  workflow: ProfileWorkflow;
  value: unknown;
  prompt: string;
}): { instruction: string; prompt: string; inputHash: string } {
  if (input.value === undefined) throw new Error("Profile workflow input is required.");
  const validation = validateTaskValue(input.workflow.inputSchema, input.value);
  if (!validation.valid) {
    throw new Error(`Profile workflow input is invalid: ${validation.issues[0]?.message ?? "schema mismatch"}`);
  }
  const instruction = input.workflow.invocation.kind === "instructions"
    ? input.workflow.invocation.instructions
    : `The released action ${input.workflow.invocation.actionId} runs before inference with the supplied workflow input. Interpret its result and do not repeat the action.`;
  return {
    instruction: `Active released Profile workflow ${input.workflow.id}:\n${instruction}`,
    prompt: `${input.prompt}\n\nReleased workflow input (task data):\n${JSON.stringify(input.value)}`,
    inputHash: canonicalHash(input.value),
  };
}
