import type { TrainingDestination } from "./destination.js";

export type CustomTrainingAdapterFactory = (config: Record<string, unknown>) => TrainingDestination;

export async function runDestinationConformance(destination: TrainingDestination): Promise<{ passed: boolean; checks: Array<{ name: string; passed: boolean; detail: string }> }> {
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
  const capabilities = await destination.capabilities();
  checks.push({ name: "identity", passed: capabilities.destinationId === destination.id, detail: `Expected ${destination.id}, received ${capabilities.destinationId}.` });
  checks.push({ name: "availability_reason", passed: capabilities.available || Boolean(capabilities.unavailableReason), detail: capabilities.available ? "available" : capabilities.unavailableReason ?? "missing reason" });
  checks.push({ name: "no_silent_method", passed: !capabilities.methods.includes("grpo") || destination.id !== "local_cpu_fixture", detail: "Local CPU fixture must not claim GRPO." });
  return { passed: checks.every((check) => check.passed), checks };
}
