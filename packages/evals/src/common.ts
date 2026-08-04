import { z } from "zod";

import { sha256Hex } from "./sha256.js";

export const MAX_PORTABLE_PATH_BYTES = 2_000;
export const MAX_PORTABLE_ASSET_BYTES = 250_000_000;
export const ReleaseIdSchema = z.string().trim().min(1).max(240);
export const ReleaseHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ReleaseTimestampSchema = z.string().datetime({ offset: true });
export const MetadataSchema = z.record(z.string(), z.unknown()).default({});

export const ImmutableReleaseRefSchema = z.object({
  id: ReleaseIdSchema,
  contentHash: ReleaseHashSchema,
}).strict();

export const ImmutableAssetRefSchema = z.object({
  id: ReleaseIdSchema,
  path: z.string().trim().min(1).max(MAX_PORTABLE_PATH_BYTES).refine(safeRelativePath),
  contentHash: ReleaseHashSchema,
  sizeBytes: z.number().int().nonnegative().max(MAX_PORTABLE_ASSET_BYTES),
  mediaType: z.string().trim().min(1).max(200),
  visibility: z.enum(["policy", "verifier", "host_private"]),
}).strict();

export const ImmutableArtifactRefSchema = z.object({
  id: ReleaseIdSchema,
  contentHash: ReleaseHashSchema,
  mediaType: z.string().trim().min(1).max(200).nullable().default(null),
  sizeBytes: z.number().int().nonnegative().max(MAX_PORTABLE_ASSET_BYTES).nullable().default(null),
}).strict();

export const FailureClassSchema = z.enum([
  "policy_failure",
  "grader_failure",
  "environment_failure",
  "infrastructure_failure",
  "timeout",
  "cancelled",
]);

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export function sha256(value: string | Uint8Array): string {
  return sha256Hex(value);
}

export function contentHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function withContentHash<T extends Record<string, unknown>>(value: T): T & { contentHash: string } {
  return { ...value, contentHash: contentHash(value) };
}

export function assertContentHash(value: { contentHash: string } & Record<string, unknown>, label: string): void {
  const { contentHash: actual, ...hashable } = value;
  const expected = contentHash(hashable);
  if (actual !== expected) throw new Error(`${label} contentHash is ${actual}; expected ${expected}.`);
}

function safeRelativePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) return false;
  return !normalized.split("/").some((part) => !part || part === "." || part === "..");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}

export type ImmutableReleaseRef = z.infer<typeof ImmutableReleaseRefSchema>;
export type ImmutableAssetRef = z.infer<typeof ImmutableAssetRefSchema>;
export type ImmutableArtifactRef = z.infer<typeof ImmutableArtifactRefSchema>;
export type FailureClass = z.infer<typeof FailureClassSchema>;
