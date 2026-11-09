import type { TaskRecord } from "@openpond/evals/tasksets";

/** The shared text-task boundary exposes only authored instructions and public
 * task input/context. Expected output and privileged assets are never messages. */
export function textTaskPolicyMessages(task: Pick<TaskRecord, "input" | "policyVisibleContext">, instructions: string) {
  return [
    { role: "system" as const, text: instructions },
    { role: "user" as const, text: JSON.stringify({ input: task.input, policyVisibleContext: task.policyVisibleContext }) },
  ] as const;
}
