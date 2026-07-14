export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function requiredStringArg(args: Record<string, unknown>, key: string): string {
  const value = stringArg(args, key, "");
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

export function stringArg(args: Record<string, unknown>, key: string, fallback: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : fallback;
}

export function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = Number(args[key]);
  return Number.isFinite(value) ? value : undefined;
}

export function booleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  return typeof args[key] === "boolean" ? args[key] : undefined;
}

export function recordArg(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = args[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function arrayArg(args: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = args[key];
  return Array.isArray(value) ? value : undefined;
}
