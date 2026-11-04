import { z } from "zod";
import type {
  SandboxRestoreInput,
  SandboxSnapshotInput,
  SandboxSnapshotRetentionQuoteInput,
  SandboxStartInput,
} from "../sandbox/types/index";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const usd = z
  .string()
  .regex(/^\d+\.\d{6}$/)
  .refine((value) => BigInt(value.replace(".", "")) > 0n);
type Options = Record<string, string | boolean>;
const text = (options: Options, key: string) =>
  typeof options[key] === "string" ? options[key].trim() : "";

/** No quote, retention limit or replacement approval is inferred locally. */
export function nativeCheckpointInput(options: Options): SandboxSnapshotInput | null {
  const keys = ["retentionClass", "retentionTtlSeconds", "retentionTermsSha256", "retentionMaxUsd"];
  if (!keys.some((key) => options[key] !== undefined)) return null;
  const retention = z
    .object({
      class: z.enum(["ephemeral", "cached", "pinned"]),
      ttlSeconds: z.coerce.number().int().positive(),
    })
    .parse({
      class: text(options, "retentionClass"),
      ttlSeconds: text(options, "retentionTtlSeconds"),
    });
  const retentionFunding = z.object({ termsSha256: sha, maxUsd: usd }).parse({
    termsSha256: text(options, "retentionTermsSha256"),
    maxUsd: text(options, "retentionMaxUsd"),
  });
  for (const key of [
    "templateName",
    "templateVersion",
    "templateVisibility",
    "validationCommand",
    "entrypointCommand",
    "description",
    "tags",
    "useCase",
  ]) {
    if (options[key] !== undefined)
      throw new Error(
        `Native checkpoint capture does not accept --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
      );
  }
  return {
    name: z.string().min(1).parse(text(options, "name")),
    replay: { retention },
    retentionFunding,
    ...(options.async === true || options.async === "true" ? { async: true } : {}),
  };
}

export function checkpointRestoreInput(options: Options): SandboxRestoreInput | undefined {
  const keys = [
    "operationId",
    "snapshotId",
    "checkpointCustodyId",
    "expectedSourceUpdatedAt",
    "replaceStoppedRoot",
  ];
  if (!keys.some((key) => options[key] !== undefined)) return undefined;
  return z
    .object({
      operationId: z.uuid(),
      checkpointId: z.string().min(1),
      checkpointCustodyId: sha,
      expectedSourceUpdatedAt: z.iso.datetime(),
      replaceStoppedRoot: z.literal(true),
    })
    .parse({
      operationId: text(options, "operationId"),
      checkpointId: text(options, "snapshotId"),
      checkpointCustodyId: text(options, "checkpointCustodyId"),
      expectedSourceUpdatedAt: text(options, "expectedSourceUpdatedAt"),
      replaceStoppedRoot:
        options.replaceStoppedRoot === true || options.replaceStoppedRoot === "true",
    });
}

export function checkpointStartInput(options: Options): SandboxStartInput {
  const keys = ["operationId", "restoreIntentSha256", "maximumUsd", "executionUntil"];
  if (!keys.some((key) => options[key] !== undefined)) return {};
  const restore = z
    .object({
      operationId: z.uuid(),
      intentSha256: sha,
      maximumUsd: usd,
      executionUntil: z.iso.datetime(),
    })
    .parse({
      operationId: text(options, "operationId"),
      intentSha256: text(options, "restoreIntentSha256"),
      maximumUsd: text(options, "maximumUsd"),
      executionUntil: text(options, "executionUntil"),
    });
  return { restore };
}

export function checkpointQuoteInput(
  options: Options,
): SandboxSnapshotRetentionQuoteInput | undefined {
  if (options.retentionClass === undefined && options.retentionTtlSeconds === undefined)
    return undefined;
  return z
    .object({
      snapshotRetentionClass: z.enum(["ephemeral", "cached", "pinned"]),
      snapshotRetentionTtlSeconds: z.coerce.number().int().positive(),
    })
    .parse({
      snapshotRetentionClass: text(options, "retentionClass"),
      snapshotRetentionTtlSeconds: text(options, "retentionTtlSeconds"),
    });
}
