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
import { ToolDeclarationSchema } from "./tasksets.js";
import { createAttemptReceipt, type AttemptReceipt, type RunManifest } from "./runs.js";

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
  capabilityRequirements: z.array(z.object({
    id: ReleaseIdSchema,
    required: z.boolean(),
    scopes: z.array(z.string().trim().min(1).max(500)).max(100),
  }).strict()).max(200),
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

export type HarnessLease = { id: string; metadata: Record<string, unknown> };
export interface HarnessRuntime {
  create(input: { manifest: RunManifest; taskId: string; seed: string; signal: AbortSignal }): Promise<HarnessLease>;
  reset(lease: HarnessLease, input: { seed: string; signal: AbortSignal }): Promise<void>;
  step(lease: HarnessLease, action: ModelAction, signal: AbortSignal): Promise<ToolObservation>;
  collect(lease: HarnessLease, signal: AbortSignal): Promise<{ artifactRefs: z.infer<typeof ImmutableArtifactRefSchema>[]; metadata: Record<string, unknown> }>;
  destroy(lease: HarnessLease): Promise<void>;
}

export type HarnessExecutionInput = {
  manifest: RunManifest;
  taskId: string;
  seed: string;
  signal?: AbortSignal;
};
export type HarnessExecutionResult = {
  receipt: AttemptReceipt;
  trace: unknown;
  output: Record<string, unknown>;
};
export interface HarnessExecutor {
  execute(input: HarnessExecutionInput): Promise<HarnessExecutionResult>;
}
export interface EvaluationRunner {
  run(input: {
    manifest: RunManifest;
    taskIds: string[];
    seeds: string[];
    repetitions: number;
    signal?: AbortSignal;
  }): Promise<HarnessExecutionResult[]>;
}

export async function executeRuntimeProtocol(input: {
  manifest: RunManifest;
  taskId: string;
  seed: string;
  actions: ModelAction[];
  runtime: HarnessRuntime;
  signal?: AbortSignal;
  now?: () => string;
}): Promise<HarnessExecutionResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason ?? new Error("Harness execution cancelled."));
  input.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Harness execution timed out.")), input.manifest.limits.timeoutMs);
  timer.unref?.();
  const events: z.infer<typeof HarnessLifecycleEventSchema>[] = [];
  const actions: ModelAction[] = [];
  const observations: ToolObservation[] = [];
  let sequence = 0;
  let lease: HarnessLease | null = null;
  let terminal = false;
  let failureClass: z.infer<typeof FailureClassSchema> | null = null;
  let output: Record<string, unknown> = {};
  let artifactRefs: z.infer<typeof ImmutableArtifactRefSchema>[] = [];
  const event = (type: z.infer<typeof HarnessLifecycleEventSchema>["type"], payload: unknown, metadata: Record<string, unknown> = {}) => {
    events.push({ sequence: sequence++, type, payloadHash: contentHash(payload), metadata });
  };
  try {
    lease = await input.runtime.create({ manifest: input.manifest, taskId: input.taskId, seed: input.seed, signal: controller.signal });
    event("created", { leaseId: lease.id });
    await input.runtime.reset(lease, { seed: input.seed, signal: controller.signal });
    event("reset", { seed: input.seed });
    for (const candidate of input.actions.slice(0, input.manifest.limits.maxTurns)) {
      if (controller.signal.aborted) throw controller.signal.reason;
      const action = ModelActionSchema.parse(candidate);
      actions.push(action);
      event("action", action);
      const observation = ToolObservationSchema.parse(await input.runtime.step(lease, action, controller.signal));
      if (observation.actionId !== action.id || observation.turn !== action.turn) {
        throw new Error(`Observation ${observation.actionId} does not match action ${action.id}.`);
      }
      observations.push(observation);
      output = observation.output;
      event("observation", observation);
      if (observation.terminal) {
        terminal = true;
        event("terminal", observation);
        break;
      }
    }
  } catch (error) {
    failureClass = controller.signal.aborted
      ? input.signal?.aborted ? "cancelled" : "timeout"
      : "infrastructure_failure";
    event("failure", { message: error instanceof Error ? error.message : String(error) }, { rewardEligible: false });
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    if (lease) {
      try {
        const collected = await input.runtime.collect(lease, new AbortController().signal);
        artifactRefs = collected.artifactRefs;
        event("collected", collected);
      } catch (error) {
        failureClass = "infrastructure_failure";
        event("failure", { message: error instanceof Error ? error.message : String(error) }, { phase: "collect", rewardEligible: false });
      }
      try {
        await input.runtime.destroy(lease);
        event("destroyed", { leaseId: lease.id });
      } catch (error) {
        failureClass = "infrastructure_failure";
        event("failure", { message: error instanceof Error ? error.message : String(error) }, { phase: "destroy", rewardEligible: false });
      }
    }
  }
  const traceContent = {
    schemaVersion: "openpond.harnessTrace.v1" as const,
    manifest: { id: input.manifest.id, contentHash: input.manifest.contentHash },
    taskId: input.taskId,
    seed: input.seed,
    events,
    actions,
    observations,
    terminal,
    failureClass,
    output,
  };
  const trace = HarnessTraceSchema.parse({ ...traceContent, contentHash: contentHash(traceContent) });
  const completedAt = now();
  const receipt = createAttemptReceipt({
    schemaVersion: "openpond.attemptReceipt.v1",
    id: `attempt-${contentHash([input.manifest.contentHash, input.taskId, input.seed, trace.contentHash]).slice(0, 24)}`,
    runManifest: { id: input.manifest.id, contentHash: input.manifest.contentHash },
    taskId: input.taskId,
    seed: input.seed,
    terminal,
    failureClass,
    outputHash: terminal ? contentHash(output) : null,
    traceHash: trace.contentHash,
    artifactRefs,
    graderEvidenceRefs: [],
    startedAt,
    completedAt,
    latencyMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    costUsd: null,
    legacyAttemptRef: null,
    metadata: {},
  });
  return { receipt, trace, output };
}

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
