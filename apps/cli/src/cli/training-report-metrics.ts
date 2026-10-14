export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function nonnegative(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
}

export function statistics(values: Array<number | null>) {
  const observed = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  const total = observed.length ? observed.reduce((sum, value) => sum + value, 0) : null;
  const quantile = (fraction: number) => observed.length
    ? observed[Math.max(0, Math.ceil(observed.length * fraction) - 1)] : null;
  return {
    observations: observed.length,
    missing: values.length - observed.length,
    total,
    mean: total === null ? null : total / observed.length,
    min: observed[0] ?? null,
    max: observed.at(-1) ?? null,
    p50: quantile(0.5),
    p95: quantile(0.95),
  };
}

export function timingStatistics(rows: Record<string, unknown>[], keys: readonly string[]) {
  return Object.fromEntries(keys.map(key => [key, statistics(rows.map(row => nonnegative(row[key])))]));
}

export function distributionStatistics(rows: Record<string, unknown>[], keys: readonly string[]) {
  return Object.fromEntries(keys.map(key => {
    const { total: _total, ...distribution } = statistics(rows.map(row => nonnegative(row[key])));
    return [key, distribution];
  }));
}

export function populationStd(values: number[]): number | null {
  if (!values.length) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

/** Codes only; never pass event/log messages or private payloads to a report. */
export function code(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value) ? value : null;
}

export function counts(values: Array<string | null>) {
  const result = new Map<string, number>();
  for (const value of values) if (value !== null) result.set(value, (result.get(value) ?? 0) + 1);
  return Object.fromEntries([...result].sort(([a], [b]) => a.localeCompare(b)));
}
