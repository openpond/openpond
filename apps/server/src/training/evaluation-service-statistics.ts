export function reviewRefMatches(
  value: unknown,
  expected: { id: string; contentHash: string },
): boolean {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { id?: unknown }).id === expected.id
    && (value as { contentHash?: unknown }).contentHash === expected.contentHash
  );
}

export function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  return values.reduce(
    (total, value) => total + (value - mean) ** 2,
    0,
  ) / values.length;
}
