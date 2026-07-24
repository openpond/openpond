import { z } from "zod";

import {
  AdapterValidationReceiptSchema,
  ResolvedTrainingPlanSchema,
  TrainingArtifactsSchema,
  TrainingExecutionRefSchema,
  TrainingExecutionStatusSchema,
} from "./training-platform.js";
import {
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
} from "./release-core.js";

export const WorkerProtocolVersionSchema = z.literal(
  "openpond.connectedWorker.v1",
);

export const WorkerHandshakeRequestSchema = z
  .object({
    protocolVersion: WorkerProtocolVersionSchema,
    clientRelease: z.string().trim().min(1).max(200),
    nonce: z.string().trim().min(16).max(1_000),
    expectedWorkerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export const WorkerHandshakeResponseSchema = z
  .object({
    protocolVersion: WorkerProtocolVersionSchema,
    workerId: ReleaseIdSchema,
    workerRelease: z.string().trim().min(1).max(200),
    workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    nonceSignature: z.string().trim().min(32).max(10_000),
    capabilityReceipt: ReleaseHashSchema,
    serverTime: ReleaseTimestampSchema,
  })
  .strict();

export const WorkerLeaseSchema = z
  .object({
    schemaVersion: z.literal("openpond.workerLease.v1"),
    id: ReleaseIdSchema,
    workerId: ReleaseIdSchema,
    acquiredAt: ReleaseTimestampSchema,
    expiresAt: ReleaseTimestampSchema,
    heartbeatAfterSeconds: z.number().int().positive().max(3_600),
    capabilityReceipt: ReleaseHashSchema,
  })
  .strict();

export const WorkerResolvedBundleSchema = z
  .object({
    objectRef: z.string().trim().min(1).max(4_000),
    bundleContentHash: ReleaseHashSchema,
    sha256: ReleaseHashSchema,
    sizeBytes: z.number().int().nonnegative(),
    format: z.enum(["directory", "tar"]),
  })
  .strict();

export const WorkerLaunchRequestSchema = z
  .object({
    leaseId: ReleaseIdSchema,
    plan: ResolvedTrainingPlanSchema,
    resolvedBundle: WorkerResolvedBundleSchema,
  })
  .strict();

export const WorkerBundleUploadSessionSchema = z
  .object({
    uploadId: ReleaseIdSchema,
    missingPaths: z.array(z.string().trim().min(1).max(2_000)),
  })
  .strict();

export const WorkerBundleUploadChunkReceiptSchema = z
  .object({
    uploadId: ReleaseIdSchema,
    path: z.string().trim().min(1).max(2_000),
    nextOffset: z.number().int().nonnegative(),
    complete: z.boolean(),
  })
  .strict();

export const WorkerEventSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    runId: ReleaseIdSchema,
    type: z.enum([
      "lease",
      "preparation",
      "log",
      "progress",
      "metric",
      "checkpoint",
      "cancellation",
      "complete",
      "failure",
    ]),
    timestamp: ReleaseTimestampSchema,
    payload: z.record(z.string(), z.unknown()),
    payloadHash: ReleaseHashSchema,
  })
  .strict();

export const WorkerLogPageSchema = z
  .object({
    cursor: z.string().max(1_000),
    entries: z.array(
      z
        .object({
          timestamp: ReleaseTimestampSchema,
          level: z.enum(["debug", "info", "warning", "error"]),
          message: z.string().max(100_000),
        })
        .strict(),
    ),
  })
  .strict();

export const WorkerArtifactChunkSchema = z
  .object({
    runId: ReleaseIdSchema,
    objectRef: z.string().trim().min(1).max(2_000),
    offset: z.number().int().nonnegative(),
    bytesBase64: z.string().max(10_000_000),
    chunkHash: ReleaseHashSchema,
    final: z.boolean(),
  })
  .strict();

export {
  AdapterValidationReceiptSchema as WorkerPlanValidationReceiptSchema,
  TrainingArtifactsSchema as WorkerTrainingArtifactsSchema,
  TrainingExecutionRefSchema as WorkerExecutionRefSchema,
  TrainingExecutionStatusSchema as WorkerExecutionStatusSchema,
};

export type WorkerHandshakeRequest = z.infer<
  typeof WorkerHandshakeRequestSchema
>;
export type WorkerHandshakeResponse = z.infer<
  typeof WorkerHandshakeResponseSchema
>;
export type WorkerLease = z.infer<typeof WorkerLeaseSchema>;
export type WorkerResolvedBundle = z.infer<typeof WorkerResolvedBundleSchema>;
export type WorkerLaunchRequest = z.infer<typeof WorkerLaunchRequestSchema>;
export type WorkerBundleUploadSession = z.infer<
  typeof WorkerBundleUploadSessionSchema
>;
export type WorkerBundleUploadChunkReceipt = z.infer<
  typeof WorkerBundleUploadChunkReceiptSchema
>;
export type WorkerEvent = z.infer<typeof WorkerEventSchema>;
export type WorkerLogPage = z.infer<typeof WorkerLogPageSchema>;
export type WorkerArtifactChunk = z.infer<typeof WorkerArtifactChunkSchema>;
