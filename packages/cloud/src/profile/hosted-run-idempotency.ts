import { createHash, randomUUID } from "node:crypto";

export type HostedRunIdempotencyKeyInput = {
  explicitKey?: string | null;
  retry?: boolean;
  localHead: string;
  sourceHead?: string | null;
  runtimeAgentId: string;
  targetProjectId?: string | null;
  input: Record<string, unknown>;
  randomId?: () => string;
};

export function buildHostedRunIdempotencyKey(input: HostedRunIdempotencyKeyInput): string {
  const explicit = input.explicitKey?.trim();
  if (explicit) return explicit;
  const sourceHead = input.sourceHead?.trim() || "unknown-source";
  const targetProjectId = input.targetProjectId?.trim() || "no-target-project";
  const inputHash = hashStableJson(input.input).slice(0, 16);
  const base = `profile-push-run:${input.localHead}:${sourceHead}:${input.runtimeAgentId}:${targetProjectId}:${inputHash}`;
  if (!input.retry) return base;
  return `${base}:retry:${(input.randomId ?? randomUUID)()}`;
}

function hashStableJson(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

function stableJsonStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJsonStringify(item)}`)
    .join(",")}}`;
}
