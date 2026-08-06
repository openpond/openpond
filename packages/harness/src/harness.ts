import { z } from "zod";

import {
  FailureClassSchema,
  ImmutableArtifactRefSchema,
  ImmutableAssetRefSchema,
  ImmutableReleaseRefSchema,
  MetadataSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  contentHash,
} from "./common.js";
import {
  CapabilityRequirementSchema,
  ToolDeclarationSchema,
} from "./tools.js";

export const PortabilityReportSchema = z.object({
  portable: z.boolean(),
  blockers: z.array(z.string().trim().min(1).max(2_000)).max(1_000),
  localOnlyAssetRefs: z.array(ReleaseIdSchema).max(10_000),
  hostPrivateAssetRefs: z.array(ReleaseIdSchema).max(10_000),
}).strict();

export const AgentSnapshotContentSchema = z.object({
  schemaVersion: z.literal("openpond.agentSnapshot.v2"),
  id: ReleaseIdSchema,
  sourceRelease: ImmutableReleaseRefSchema.nullable(),
  instructions: z.array(ImmutableAssetRefSchema).max(10_000),
  skills: z.array(ImmutableAssetRefSchema).max(10_000),
  agents: z.array(ImmutableAssetRefSchema).max(10_000),
  toolDeclarations: z.array(ToolDeclarationSchema).max(200),
  capabilityRequirements: z.array(CapabilityRequirementSchema).max(200),
  dependencyLock: ImmutableAssetRefSchema,
  portability: PortabilityReportSchema,
  metadata: MetadataSchema,
}).strict();
export const AgentSnapshotSchema = AgentSnapshotContentSchema.extend({ contentHash: ReleaseHashSchema }).strict();

export const LifecycleContractSchema = z.object({
  create: z.literal(true),
  reset: z.literal(true),
  step: z.literal(true),
  collect: z.literal(true),
  destroy: z.literal(true),
  resetScope: z.enum(["task", "attempt"]),
}).strict();
export const GraderInterfaceContractSchema = z.object({
  visibleEvidence: z.array(ReleaseIdSchema).max(1_000),
  privilegedEvidence: z.array(ReleaseIdSchema).max(1_000),
  privateVerifierIsolation: z.boolean(),
}).strict();

export const HarnessReleaseContentSchema = z.object({
  schemaVersion: z.literal("openpond.harnessRelease.v2"),
  id: ReleaseIdSchema,
  agentSnapshot: ImmutableReleaseRefSchema,
  program: ImmutableAssetRefSchema,
  tools: z.array(ToolDeclarationSchema).max(200),
  lifecycle: LifecycleContractSchema,
  graderInterface: GraderInterfaceContractSchema,
  files: z.array(ImmutableAssetRefSchema).max(100_000),
  metadata: MetadataSchema,
}).strict();
export const HarnessReleaseSchema = HarnessReleaseContentSchema.extend({ contentHash: ReleaseHashSchema }).strict();

export const ModelActionSchema = z.object({
  id: ReleaseIdSchema,
  turn: z.number().int().nonnegative(),
  kind: z.enum(["message", "tool_call", "terminal"]),
  name: ReleaseIdSchema.nullable(),
  arguments: z.record(z.string(), z.unknown()),
  content: z.string().max(1_000_000).nullable(),
}).strict();
export const ToolObservationSchema = z.object({
  actionId: ReleaseIdSchema,
  turn: z.number().int().nonnegative(),
  terminal: z.boolean(),
  output: z.record(z.string(), z.unknown()),
  artifactRefs: z.array(ImmutableArtifactRefSchema).max(100_000),
}).strict();

export function createAgentSnapshot(input: z.input<typeof AgentSnapshotContentSchema>): AgentSnapshot {
  const content = AgentSnapshotContentSchema.parse(input);
  return AgentSnapshotSchema.parse({ ...content, contentHash: contentHash(content) });
}
export function createHarnessRelease(input: z.input<typeof HarnessReleaseContentSchema>): HarnessRelease {
  const content = HarnessReleaseContentSchema.parse(input);
  return HarnessReleaseSchema.parse({ ...content, contentHash: contentHash(content) });
}

export const HarnessLifecycleEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  type: z.enum(["created", "reset", "action", "observation", "terminal", "failure", "collected", "destroyed"]),
  payloadHash: ReleaseHashSchema,
  metadata: MetadataSchema,
}).strict();
export const HarnessTraceSchema = z.object({
  schemaVersion: z.literal("openpond.harnessTrace.v1"),
  manifest: ImmutableReleaseRefSchema,
  taskId: ReleaseIdSchema,
  seed: z.string().trim().min(1).max(500),
  events: z.array(HarnessLifecycleEventSchema).max(1_000_000),
  actions: z.array(ModelActionSchema).max(100_000),
  observations: z.array(ToolObservationSchema).max(100_000),
  terminal: z.boolean(),
  failureClass: FailureClassSchema.nullable(),
  output: z.record(z.string(), z.unknown()),
  contentHash: ReleaseHashSchema,
}).strict();

export type AgentSnapshot = z.infer<typeof AgentSnapshotSchema>;
export type HarnessRelease = z.infer<typeof HarnessReleaseSchema>;
export type ModelAction = z.infer<typeof ModelActionSchema>;
export type ToolObservation = z.infer<typeof ToolObservationSchema>;
export type HarnessTrace = z.infer<typeof HarnessTraceSchema>;
