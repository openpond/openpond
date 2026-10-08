// Generated from Sandbox shared/remote-device.ts. Do not edit.
// Source SHA256: d3f24f0c33475473bc304ff2579681db24cd6d596093a6678b0dc88357ab587b
// Refresh: node scripts/sync-remote-device-contract.mjs
import { z } from "zod";
export const REMOTE_DEVICE_PROTOCOL_VERSION = 1 as const;
export const REMOTE_DEVICE_LIMITS = {
  frameBytes: 262144,
  socketQueueBytes: 1048576,
  workerQueueBytes: 67108864,
  viewerSubscriptions: 20,
  deviceSubscriptions: 100,
  ticketMs: 30000,
  leaseMs: 60000,
  permitMs: 15000,
  historyTaskBytes: 10485760,
  historyDeviceBytes: 104857600,
  artifactBytes: 26214400,
} as const;
const id = z.string().min(1).max(200);
export const RemoteDeviceScopeSchema = z
  .object({
    installationId: z.string().uuid(),
    profileId: id,
    ownerUserId: id,
    teamId: id,
  })
  .strict();
export type RemoteDeviceScope = z.infer<typeof RemoteDeviceScopeSchema>;
export const RemoteDeviceProofSchema = z
  .object({
    version: z.literal(1),
    scope: RemoteDeviceScopeSchema,
    runtimeId: z.string().uuid(),
    audience: z.string().url(),
    nonce: z.string().uuid(),
    issuedAt: z.string().datetime(),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    signature: z.string().max(256),
  })
  .strict();
export type RemoteDeviceProof = z.infer<typeof RemoteDeviceProofSchema>;
export function remoteDeviceProofMessage(
  proof: Omit<RemoteDeviceProof, "signature">,
): string {
  return JSON.stringify([
    "remote-device",
    proof.version,
    proof.scope.installationId,
    proof.scope.profileId,
    proof.scope.ownerUserId,
    proof.scope.teamId,
    proof.runtimeId,
    proof.audience,
    proof.nonce,
    proof.issuedAt,
    proof.payloadHash,
  ]);
}
export function remoteDeviceCanonicalContent(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, canonical(x)]),
      );
    return v;
  };
  return JSON.stringify(canonical(value));
}
export const RemoteTaskCapabilitiesSchema = z
  .object({
    followUp: z.boolean(),
    steer: z.boolean(),
    stop: z.boolean(),
    approval: z.boolean(),
    artifacts: z.boolean(),
    start: z.boolean().optional(),
  })
  .strict();
export type RemoteTaskCapabilities = z.infer<
  typeof RemoteTaskCapabilitiesSchema
>;
export const RemoteTaskSchema = z
  .object({
    id: id,
    localSessionId: id,
    title: z.string().max(1000),
    projectId: id.nullable(),
    projectLabel: z.string().max(1000).nullable(),
    provider: z.string().max(100),
    capabilities: RemoteTaskCapabilitiesSchema,
    state: z.enum(["idle", "running", "completed", "failed", "attention"]),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    historyGeneration: id,
    lastEventSequence: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    activeTurnId: id.nullable().optional(),
    approvalId: id.nullable().optional(),
    createdAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
    archived: z.boolean().default(false),
    deleted: z.boolean().default(false),
  })
  .strict();
export type RemoteTask = z.infer<typeof RemoteTaskSchema>;
export const RemoteCommandInputSchema = z
  .object({
    idempotencyKey: id,
    action: z.enum(["follow_up", "steer", "stop", "start", "approval"]),
    targetId: id,
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    expectedTurnId: id.nullable().optional(),
    expectedApprovalId: id.nullable().optional(),
    expiresAt: z.string().datetime().optional(),
    payload: z
      .object({
        text: z.string().max(100000).optional(),
        response: z.enum(["approve", "reject"]).optional(),
        projectId: id.optional(),
        starterId: id.optional(),
        starterRevision: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
      })
      .strict(),
  })
  .strict();
export type RemoteCommandInput = z.infer<typeof RemoteCommandInputSchema>;
export type RemoteCommandState =
  | "accepted"
  | "dispatching"
  | "admitted"
  | "applied"
  | "rejected"
  | "expired"
  | "cancelled"
  | "reconciling";
export type RemoteCommandReceipt = {
  id: string;
  deviceId: string;
  state: RemoteCommandState;
  revision: number;
  payloadHash: string;
  action: RemoteCommandInput["action"];
  targetId: string;
  localSessionId?: string;
  remoteTaskId?: string;
  inputId?: string;
  turnId?: string;
  approvalId?: string;
  error?: string;
  createdAt: string;
  expiresAt: string;
};
export type RemoteDevice = {
  id: string;
  installationId: string;
  profileId: string;
  name: string;
  platform: string;
  status:
    | "connected"
    | "offline"
    | "off"
    | "connecting"
    | "reconnecting"
    | "update_required";
  enabled: boolean;
  removed: boolean;
  revision: number;
  lastSeenAt: string | null;
  lastCatalogSyncAt: string | null;
  taskCount: number;
};
export type RemoteHistoryItem = {
  id: string;
  sequence: number;
  messageId?: string;
  turnId?: string;
  textMode?: "append" | "replace";
  fragmentIndex?: number;
  fragmentCount?: number;
  type: "message" | "tool" | "state" | "approval";
  role?: "user" | "assistant" | "system";
  text?: string;
  toolName?: string;
  status?: string;
  approvalId?: string;
  artifactIds?: string[];
  truncated?: boolean;
};
export const RemoteHistoryItemSchema = z
  .object({
    id,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    messageId: id.optional(),
    turnId: id.optional(),
    textMode: z.enum(["append", "replace"]).optional(),
    fragmentIndex: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    fragmentCount: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    type: z.enum(["message", "tool", "state", "approval"]),
    role: z.enum(["user", "assistant", "system"]).optional(),
    text: z.string().max(100000).optional(),
    toolName: z.string().max(200).optional(),
    status: z.string().max(100).optional(),
    approvalId: id.optional(),
    artifactIds: z.array(id).max(100).optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type RemoteHistoryPage = {
  snapshotId: string;
  taskId: string;
  historyGeneration: string;
  watermark: number;
  items: RemoteHistoryItem[];
  nextCursor: string | null;
  capturedAt: string;
  provenance: "live" | "cached";
};
export type RemoteDispatchCommand = RemoteCommandInput & {
  id: string;
  deviceId: string;
  payloadHash: string;
  scope: RemoteDeviceScope;
  grantRevision: number;
  fence: number;
  deadline: string;
  actor: "remote-human" | "ponder";
  localSessionId?: string;
  localStarterId?: string;
  permit: { keyId: string; signature: string; expiresAt: string };
};
/** Device/viewer frames use JSON. Routing is derived by the relay, never client subjects. */
export type RemoteDeviceFrame = {
  protocolVersion: 1;
  type: string;
  requestId?: string;
  deviceId?: string;
  epoch?: string;
  fence?: number;
  taskId?: string;
  payload?: unknown;
};
export function remoteDevicePermitMessage(
  command: Omit<RemoteDispatchCommand, "permit">,
  expiresAt: string,
  keyId: string,
): string {
  return remoteDeviceCanonicalContent({
    domain: "remote-device-dispatch-v1",
    command,
    expiresAt,
    keyId,
  });
}
export type RemoteDeviceServicePublicKey = { keyId: string; publicKey: string };
export const RemoteStarterSchema = z
  .object({
    id: z.string().min(1).max(200),
    projectId: z.string().min(1).max(200),
    projectLabel: z.string().max(1000),
    title: z.string().max(1000),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type RemoteStarter = z.infer<typeof RemoteStarterSchema>;
