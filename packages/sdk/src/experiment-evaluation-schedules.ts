import {EvaluationCoordinationTransport,type EvaluationCoordinationAccess} from "./evaluation-coordination-http.js";
import { z } from "zod";
import {
  contentHash,
  assertContentHash,
  ImmutableReleaseRefSchema,
} from "@openpond/harness";
import { NightlyScheduleSchema } from "@openpond/evals/learning";
import { RunExperimentSchema } from "./experiments.js";
const Id = z.string().trim().min(1).max(200),
  Hash = z.string().regex(/^[a-f0-9]{64}$/),
  Time = z.string().datetime();
export const ExperimentEvaluationScheduleInputSchema = z
  .object({
    operationId: Id,
    id: Id.optional(),
    expectedRevision: z.number().int().nonnegative(),
    teamId: Id,
    projectId: Id.nullable(),
    enabled: z.boolean(),
    configuration: RunExperimentSchema,
    cadence: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("interval"),
          seconds: z.number().int().min(60).max(31536000),
        })
        .strict(),
      z
        .object({ kind: z.literal("nightly"), calendar: NightlyScheduleSchema })
        .strict(),
    ]),
    maximumTotalSpendUsd: z.number().finite().positive().max(10000),
    maximumAttempts: z.number().int().min(1).max(20),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.configuration.request.teamId !== v.teamId ||
      (v.configuration.request.project?.id ?? null) !== v.projectId
    )
      c.addIssue({
        code: "custom",
        message:
          "The scheduled Experiment must retain its actual workspace and Project.",
      });
    if (v.configuration.maximumCostUsd > v.maximumTotalSpendUsd)
      c.addIssue({
        code: "custom",
        message:
          "The run ceiling exceeds the approved cumulative schedule ceiling.",
      });
  });
export const ExperimentEvaluationFireSchema = z
  .object({
    id: Id,
    scheduledAt: Time,
    coalescedThroughAt: Time,
    coalescedCount: z.number().int().nonnegative(),
    configurationHash: Hash,
    operationId: Id,
    state: z.enum([
      "reserved",
      "dispatching",
      "running",
      "cleaning",
      "completed",
      "failed",
      "cancelled",
      "uncertain",
    ]),
    executionId: Id.nullable(),
    attempt: z.number().int().positive(),
    maximumCostUsd: z.number().finite().positive(),
    actualSpendUsd: z.number().finite().nonnegative().nullable(),
    cleanupComplete: z.boolean(),
    error: z.string().max(4000).nullable(),
  })
  .strict();
export const ExperimentEvaluationScheduleSchema = z
  .object({
    schemaVersion: z.literal("openpond.experimentEvaluationSchedule.v1"),
    id: Id,
    revision: z.number().int().positive(),
    actorId: Id,
    teamId: Id,
    projectId: Id.nullable(),
    operationId: Id,
    requestHash: Hash,
    configuration: RunExperimentSchema,
    configurationHash: Hash,
    cadence: ExperimentEvaluationScheduleInputSchema.shape.cadence,
    state: z.enum(["scheduled", "disabled", "blocked"]),
    nextRunAt: Time.nullable(),
    maximumTotalSpendUsd: z.number().finite().positive(),
    maximumAttempts: z.number().int().positive(),
    lastEvaluatedConfigurationHash: Hash.nullable(),
    newerUnevaluatedRelease: ImmutableReleaseRefSchema.nullable(),
    fires: z.array(ExperimentEvaluationFireSchema).max(10000),
    reason: z.string().max(4000).nullable(),
    createdAt: Time,
    updatedAt: Time,
    contentHash: Hash,
  })
  .strict();
export type ExperimentEvaluationSchedule = z.infer<
  typeof ExperimentEvaluationScheduleSchema
>;
export type ExperimentEvaluationScheduleInput = z.infer<
  typeof ExperimentEvaluationScheduleInputSchema
>;
export type ExperimentEvaluationFire = z.infer<
  typeof ExperimentEvaluationFireSchema
>;
export function scheduledExperimentHash(
  value: z.infer<typeof RunExperimentSchema>,
) {
  const { operationId: _operation, request, ...rest } = value;
  const { operationId: _requestOperation, ...body } = request;
  void _operation;
  void _requestOperation;
  return contentHash({ ...rest, request: body });
}
export function verifyExperimentEvaluationSchedule(raw: unknown) {
  const v = ExperimentEvaluationScheduleSchema.parse(raw);
  assertContentHash(v, "Scheduled Experiment");
  if (
    v.configurationHash !== scheduledExperimentHash(v.configuration) ||
    v.configuration.request.teamId !== v.teamId ||
    (v.configuration.request.project?.id ?? null) !== v.projectId
  )
    throw new Error(
      "Scheduled Experiment immutable authority differs from its recipe.",
    );
  return v;
}
export function sealExperimentEvaluationSchedule(
  value: Omit<ExperimentEvaluationSchedule, "contentHash">,
) {
  return verifyExperimentEvaluationSchedule({
    ...value,
    contentHash: contentHash(value),
  });
}
export const ExperimentEvaluationScheduleControlSchema = z
  .object({
    teamId: Id,
    id: Id,
    operationId: Id,
    expectedRevision: z.number().int().positive(),
    action: z.enum(["cancel_active", "retry_active", "pause"]),
  })
  .strict();

export const ExperimentEvaluationScheduleCommandSchema = z.discriminatedUnion(
  "operation",
  [
    z
      .object({
        operation: z.literal("publish"),
        request: ExperimentEvaluationScheduleInputSchema,
      })
      .strict(),
    z
      .object({
        operation: z.literal("control"),
        request: ExperimentEvaluationScheduleControlSchema,
      })
      .strict(),
    z.object({ operation: z.literal("read"), id: Id }).strict(),
    z
      .object({
        operation: z.literal("list"),
        cursor: Id.optional(),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .strict(),
  ],
);

export class OpenPondExperimentEvaluationScheduleClient {
  private readonly transport:EvaluationCoordinationTransport;
  constructor(access:EvaluationCoordinationAccess){this.transport=new EvaluationCoordinationTransport(access);}
  async command(raw:z.input<typeof ExperimentEvaluationScheduleCommandSchema>,signal?:AbortSignal){
    const request=ExperimentEvaluationScheduleCommandSchema.parse(raw),access=this.transport.access;
    if((request.operation==="publish"&&(request.request.teamId!==access.teamId||request.request.projectId!==access.projectId))||(request.operation==="control"&&request.request.teamId!==access.teamId))throw new Error("The schedule command belongs to another workspace or Project.");
    const value=await this.transport.post("experiment-evaluation-schedules",request,signal);
    const page=request.operation==="list"?z.object({items:z.array(z.unknown()).max(request.limit),nextCursor:z.string().nullable()}).strict().parse(value):null;
    const items=(page?.items??[value]).map(raw=>{const schedule=verifyExperimentEvaluationSchedule(raw);if(schedule.actorId!==access.actorId||schedule.teamId!==access.teamId||schedule.projectId!==access.projectId||request.operation==="read"&&schedule.id!==request.id||request.operation==="control"&&schedule.id!==request.request.id||request.operation==="publish"&&(schedule.requestHash!==contentHash(request.request)||Boolean(request.request.id&&schedule.id!==request.request.id)))throw new Error("Schedule readback differs from its exact owner command.");return schedule;});
    return page?{items,nextCursor:page.nextCursor}:items[0]!;
  }
}
