/** Recurring training routes supported by the shared policy compiler.
 * One-stage execution and runtime qualification remain separate decisions. */
export function supportsRecurringModelTraining(method: string | null | undefined): boolean {
  return method === "sft" || method === "grpo";
}
