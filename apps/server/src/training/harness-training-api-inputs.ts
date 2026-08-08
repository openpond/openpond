export type ImmutableRef = { id: string; contentHash: string };

export function harnessIntegerArray(value: unknown, label: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item))) {
    throw new Error(`${label} must be an array of integers.`);
  }
  return value as number[];
}

export function nonnegativeHarnessNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return value;
}

export function optionalImmutableRef(value: unknown, name: string): ImmutableRef | null {
  if (value === undefined || value === null) return null;
  return requiredImmutableRef(value, name);
}

export function requiredImmutableRef(value: unknown, name: string): ImmutableRef {
  const candidate = record(value);
  return {
    id: requiredString(candidate.id, `${name}.id`),
    contentHash: requiredString(candidate.contentHash, `${name}.contentHash`),
  };
}

export function sameImmutableRef(value: unknown, expected: ImmutableRef): boolean {
  const candidate = record(value);
  return candidate.id === expected.id && candidate.contentHash === expected.contentHash;
}

export function recipeBaseModelId(recipe: Record<string, unknown>): string {
  const method = recipe.method;
  const base = record(recipe.baseModel);
  if (method === "sft" || method === "grpo") {
    return requiredString(base.id, "recipe.baseModel.id");
  }
  if (method === "dpo") {
    return requiredString(record(recipe.policyModel).id, "recipe.policyModel.id");
  }
  if (method === "ppo") {
    return requiredString(
      record(record(recipe.policyOptimization).policyModel).id,
      "recipe.policyOptimization.policyModel.id",
    );
  }
  throw new Error("Qualified training recipe method is not executable.");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}
