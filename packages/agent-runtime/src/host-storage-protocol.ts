import { z } from "zod";
import { TaskInboxStorageParamsSchema } from "./task-inbox-storage-protocol.js";
import { RefinerStorageActionSchema } from "./refiner-storage-protocol.js";
import { HostedOutputBeginParamsSchema, HostedOutputChunkParamsSchema,
  HostedOutputCompleteParamsSchema, HostedOutputSaveSandboxFileParamsSchema } from "./host-output-storage-protocol.js";
import { HostedSandboxRequestParamsSchema,
  HostedToolAuthorizationParamsSchema } from "./host-embedded-execution-protocol.js";

/** Private child-to-host storage contract; never exposed as a public app RPC. */
export const HOST_STORAGE_CONTRACT_VERSION = 1;

const id = z.string().trim().min(1).max(191);
const pageSize = z.number().int().min(1).max(200);

export const HostStorageScopeSchema = z.object({
  teamId: id,
  ownerUserId: id,
  workspaceId: id,
  conversationId: id,
  turnId: id,
  attempt: z.number().int().min(1),
  leaseGeneration: z.number().int().min(1),
}).strict();

export const HostStorageRequestSchema = z.discriminatedUnion("operation", [
  z.object({ contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION), requestId: id,
    operation: z.literal("sandbox/request"), params: HostedSandboxRequestParamsSchema }).strict(),
  z.object({ contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION), requestId: id,
    operation: z.literal("embedding/authorize"), params: HostedToolAuthorizationParamsSchema }).strict(),
  z.object({ contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION), requestId: id,
    operation: z.literal("output/begin"), params: HostedOutputBeginParamsSchema }).strict(),
  z.object({ contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION), requestId: id,
    operation: z.literal("output/chunk"), params: HostedOutputChunkParamsSchema }).strict(),
  z.object({ contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION), requestId: id,
    operation: z.literal("output/complete"), params: HostedOutputCompleteParamsSchema }).strict(),
  z.object({ contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION), requestId: id,
    operation: z.literal("output/saveSandboxFile"), params: HostedOutputSaveSandboxFileParamsSchema }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("settings/get"),
    params: z.object({}).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("harness/get"),
    params: z.object({ reference: z.object({ id, contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().nullable() }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("harness/overlay/get"),
    params: z.object({ runId: id }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("harness/overlay/put"),
    params: z.object({
      runId: id,
      expectedRevision: z.number().int().min(0).nullable(),
      overlay: z.record(z.string(), z.unknown()),
    }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("harness/overlay/freezeProposal"),
    params: z.object({
      runId: id,
      expectedRevision: z.number().int().min(0),
      overlay: z.record(z.string(), z.unknown()),
      proposal: z.record(z.string(), z.unknown()),
    }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("harness/memory/get"),
    params: z.object({ workspaceId: id, key: z.string().min(1).max(120) }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("harness/memory/list"),
    params: z.object({ workspaceId: id, includeDeleted: z.boolean(),
      before: z.object({ updatedAt: z.string(), key: z.string() }).strict().nullable(), limit: pageSize }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("harness/memory/write"),
    params: z.object({ input: z.record(z.string(), z.unknown()) }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("harness/state/read"),
    params: z.object({ workspaceId: id,
      kind: z.enum(["selection", "workspace_settings", "evaluation_review_settings", "candidates", "cross_run_requests"]),
      afterId: id.nullable(), limit: z.number().int().min(1).max(100) }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("harness/workspace/transition"),
    params: z.discriminatedUnion("action", [
      z.object({ action: z.literal("advance"), receiptId: id, workspaceId: id,
        proposal: z.record(z.string(), z.unknown()), validations: z.array(z.record(z.string(), z.unknown())).max(100),
        nextRelease: z.object({ id, contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
        nextSourceRevision: z.string().min(1), now: z.string() }).strict(),
      z.object({ action: z.literal("reviewedAdvance"), receiptId: id, workspaceId: id,
        proposal: z.record(z.string(), z.unknown()), validations: z.array(z.record(z.string(), z.unknown())).max(100),
        nextRelease: z.object({ id, contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
        nextSourceRevision: z.string().min(1), reviewer: id, now: z.string() }).strict(),
      z.object({ action: z.literal("rollback"), receiptId: id, workspaceId: id,
        expectedWorkspaceRevision: z.number().int().nonnegative(), expectedChannelRevision: z.number().int().nonnegative(),
        targetRelease: z.object({ id, contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
        targetSourceRevision: z.string().min(1),
        rollbackOf: z.object({ id, contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
        now: z.string() }).strict(),
    ]),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("task-inbox/execute"),
    params: TaskInboxStorageParamsSchema,
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("refiner/execute"),
    params: z.object({ action: RefinerStorageActionSchema }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("create-improve/execute"),
    params: z.discriminatedUnion("action", [
      z.object({ action: z.literal("get"), runId: id }).strict(),
      z.object({ action: z.literal("page"), query: z.object({
        profileId: id.nullable(), targetKind: id.nullable(), targetId: id.nullable(),
        state: z.array(id).max(20),
      }).strict(), before: z.object({ updatedAt: z.string(), id }).strict().nullable(), limit: pageSize }).strict(),
      z.object({ action: z.literal("put"), run: z.record(z.string(), z.unknown()) }).strict(),
      z.object({ action: z.literal("mutate"), mutation: z.record(z.string(), z.unknown()),
        next: z.record(z.string(), z.unknown()) }).strict(),
    ]),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("approval/get"),
    params: z.object({ approvalId: id }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("approval/upsert"),
    params: z.object({ approval: z.record(z.string(), z.unknown()), expectedRevision: z.number().int().min(1).nullable() }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("usage/getByRequestId"),
    params: z.object({ requestId: id }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("usage/upsert"),
    params: z.object({ record: z.record(z.string(), z.unknown()) }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("usage/page"),
    params: z.object({
      query: z.object({
        sessionId: id.optional(), turnId: id.optional(), provider: id.optional(), model: id.optional(),
        startedAtFrom: z.string().optional(), startedAtTo: z.string().optional(),
        visibility: z.enum(["user_facing", "background", "system"]).optional(),
        status: z.enum(["started", "completed", "failed", "interrupted", "missing"]).optional(),
      }).strict(),
      before: z.object({ startedAt: z.string(), requestOrdinal: z.number().int().min(0), id }).strict().nullable(),
      limit: pageSize,
    }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("capabilities"),
    params: z.object({}).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("session/count"),
    params: z.object({}).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("session/get"),
    params: z.object({ sessionId: id }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("session/page"),
    params: z.object({ afterId: id.nullable(), limit: pageSize }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("session/put"),
    params: z.object({
      sessionId: id,
      expectedRevision: z.number().int().min(1).nullable(),
      session: z.record(z.string(), z.unknown()),
    }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("turn/count"),
    params: z.object({ sessionId: id }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("turn/wakeCount"),
    params: z.object({ sessionId: id,
      key: z.enum(["messageId", "fromRunId"]), value: id }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("turn/get"),
    params: z.object({ turnId: id }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("turn/put"),
    params: z.object({
      sessionId: id,
      turnId: id,
      expectedRevision: z.number().int().min(1).nullable(),
      turn: z.record(z.string(), z.unknown()),
    }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("turn/latest"),
    params: z.object({
      sessionId: id,
      status: z.enum(["in_progress", "completed", "failed", "interrupted"]).nullable(),
    }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("turn/page"),
    params: z.object({
      sessionId: id,
      beforeSortIndex: z.number().int().min(0).nullable().optional(),
      limit: pageSize,
    }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("thread/turnPage"),
    params: z.object({
      sessionId: id,
      beforeSortIndex: z.number().int().min(0).nullable().optional(),
      limit: pageSize,
    }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("event/append"),
    params: z.object({ event: z.record(z.string(), z.unknown()) }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("events/page"),
    params: z.object({
      sessionId: id.nullable(),
      afterSequence: z.number().int().min(0),
      beforeSequence: z.number().int().min(1).nullable().optional(),
      limit: pageSize,
    }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
    requestId: id,
    operation: z.literal("events/latestAssistantText"),
    params: z.object({ sessionId: id }).strict(),
  }).strict(),
]);

export const HostStorageCapabilitySchema = z.object({
  contractVersion: z.literal(HOST_STORAGE_CONTRACT_VERSION),
  operations: z.array(z.enum(["sandbox/request", "embedding/authorize", "output/begin", "output/chunk", "output/complete", "output/saveSandboxFile", "settings/get", "harness/get", "harness/overlay/get", "harness/overlay/put", "harness/overlay/freezeProposal", "harness/memory/get", "harness/memory/list", "harness/memory/write", "harness/state/read", "harness/workspace/transition", "task-inbox/execute", "refiner/execute", "create-improve/execute", "approval/get", "approval/upsert", "usage/getByRequestId", "usage/upsert", "usage/page", "session/count", "session/get", "session/page", "session/put", "turn/count", "turn/wakeCount", "turn/get", "turn/put", "turn/latest", "turn/page", "thread/turnPage", "event/append", "events/page", "events/latestAssistantText"])).max(40),
  allowedTools: z.array(id).max(128),
  maxPageSize: pageSize,
  maxRequestBytes: z.number().int().min(1).max(1_000_000),
  maxInFlight: z.number().int().min(1).max(64),
}).strict();

export type HostStorageScope = z.infer<typeof HostStorageScopeSchema>;
export type HostStorageRequest = z.infer<typeof HostStorageRequestSchema>;
export type HostStorageCapability = z.infer<typeof HostStorageCapabilitySchema>;
