import { createHash } from "node:crypto";

const MAX_CAPTURED_OUTPUT_CHARS = 200_000;

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  const record = asRecord(parsed);
  if (!record) throw new Error("Expected JSON object");
  return record;
}

export function parseJsonObjectSafe(
  value: string
): Record<string, unknown> | null {
  try {
    return parseJsonObject(value.trim());
  } catch {
    return null;
  }
}

export function readPath(value: unknown, pathParts: string[]): unknown {
  let current = value;
  for (const part of pathParts) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[part];
  }
  return current;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return typeof error === "string" ? error : String(error);
}

export function trimOutput(value: string): string {
  if (value.length <= MAX_CAPTURED_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_CAPTURED_OUTPUT_CHARS)}\n[truncated]`;
}
