import { ModelComparisonEntryRefSchema } from "@openpond/contracts";

export function portableMethod(
  value: string | null | undefined,
): "sft" | "dpo" | "grpo" | "ppo" | undefined {
  return value === "sft" || value === "dpo" || value === "grpo" || value === "ppo"
    ? value
    : undefined;
}

export function optionalComparisonEntryRef(value: unknown) {
  return value === undefined || value === null
    ? null
    : ModelComparisonEntryRefSchema.parse(value);
}

export function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
