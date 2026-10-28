import { createTrainingRequest, type TrainingTransportOptions } from "./training-transport.js";
export { OpenPondTrainingApiError } from "./training-transport.js";
import { z } from "zod";
import { OpenPondProtocolError } from "./protocol.js";

// Read-only hardware observation wire contract. The producer and ingestion
// service supply bounded, explicitly scoped observations;
// observation freshness never establishes worker liveness or scheduling readiness.
const Id = z.string().min(1).max(191);
const Timestamp = z.string().datetime({ offset: true });
const Text = z.string().min(1).max(512);
const Counter = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const MissingMetric = z
  .object({
    status: z.enum(["unavailable", "unsupported", "permissionDenied", "error"]),
    reason: Text,
  })
  .strict();
const metric = <T extends z.ZodType>(value: T) =>
  z.union([z.object({ status: z.literal("available"), value }).strict(), MissingMetric]);
const NumberMetric = metric(Counter);
const PercentMetric = metric(z.number().finite().min(0).max(100));
const StringMetric = metric(Text);
export const HardwareAvailabilitySchema = z.union([
  z.object({ status: z.literal("available") }).strict(),
  MissingMetric,
]);
export const HardwareGpuObservationSchema = z
  .object({
    index: z.number().int().min(0).max(4_294_967_295),
    uuid: StringMetric,
    name: StringMetric,
    pciBusId: StringMetric,
    memoryTotalBytes: NumberMetric,
    memoryUsedBytes: NumberMetric,
    utilizationPercent: PercentMetric,
    memoryUtilizationPercent: PercentMetric,
    temperatureCelsius: NumberMetric,
    powerWatts: NumberMetric,
    powerLimitWatts: NumberMetric,
    graphicsClockMhz: NumberMetric,
    memoryClockMhz: NumberMetric,
    eccCorrectedErrors: NumberMetric,
    eccUncorrectedErrors: NumberMetric,
  })
  .strict();
export const HardwareObservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    collectorVersion: Text,
    sessionId: z.string().uuid(),
    sequence: Counter.int().min(1),
    observedAt: Timestamp,
    monotonicMs: Counter.int(),
    sampleIntervalMs: z.number().int().min(100).max(60_000),
    scope: z.enum(["container", "host", "guest", "unknown"]),
    cpu: z
      .object({
        logicalCores: NumberMetric,
        utilizationPercent: PercentMetric,
        cgroupCpuLimitCores: NumberMetric,
        cgroupUsageUsec: NumberMetric,
      })
      .strict(),
    memory: z
      .object({
        hostTotalBytes: NumberMetric,
        hostAvailableBytes: NumberMetric,
        cgroupLimitBytes: NumberMetric,
        cgroupCurrentBytes: NumberMetric,
      })
      .strict(),
    driverVersion: StringMetric,
    gpus: z.array(HardwareGpuObservationSchema).max(32),
    capabilities: z
      .object({
        cpu: HardwareAvailabilitySchema,
        memory: HardwareAvailabilitySchema,
        nvml: HardwareAvailabilitySchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const indices = new Set<number>();
    const uuids = new Set<string>();
    value.gpus.forEach((gpu, index) => {
      if (
        indices.has(gpu.index) ||
        (gpu.uuid.status === "available" && uuids.has(gpu.uuid.value))
      ) {
        context.addIssue({
          code: "custom",
          path: ["gpus", index],
          message: "GPU identity must be unique within an observation.",
        });
      }
      indices.add(gpu.index);
      if (gpu.uuid.status === "available") uuids.add(gpu.uuid.value);
    });
  });
export const HardwareFleetSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    teamId: Id,
    observedAt: Timestamp,
    nextCursor: Id.nullable(),
    workers: z
      .array(
        z
          .object({
            workerId: Id,
            provider: Id,
            state: Id,
            jobIds: z.array(Id).max(128),
            receivedAt: Timestamp.nullable(),
            observation: HardwareObservationSchema.nullable(),
            freshness: z.enum(["missing", "fresh", "stale"]),
          })
          .strict(),
      )
      .max(50),
  })
  .strict()
  .superRefine((value, context) => {
    const workers = new Set<string>();
    value.workers.forEach((worker, index) => {
      if (workers.has(worker.workerId))
        context.addIssue({
          code: "custom",
          path: ["workers", index, "workerId"],
          message: "Duplicate worker identity.",
        });
      workers.add(worker.workerId);
      if (
        (worker.observation === null) !== (worker.receivedAt === null) ||
        (worker.observation === null) !== (worker.freshness === "missing")
      ) {
        context.addIssue({
          code: "custom",
          path: ["workers", index],
          message: "Observation, receive time and freshness must describe the same evidence.",
        });
      }
    });
  });
export type HardwareObservation = z.infer<typeof HardwareObservationSchema>;
export type HardwareFleetSnapshot = z.infer<typeof HardwareFleetSnapshotSchema>;
export type HardwareObservationQuery = {
  teamId: string;
  workerId?: string;
  jobId?: string;
  cursor?: string;
  limit?: number;
};

export function createTrainingHardwareClient(
  request: (path: string, init?: RequestInit) => Promise<unknown>,
) {
  return {
    async hardwareObservations(query: HardwareObservationQuery): Promise<HardwareFleetSnapshot> {
      const teamId = Id.parse(query.teamId);
      const params = new URLSearchParams();
      if (query.workerId !== undefined) params.set("workerId", Id.parse(query.workerId));
      if (query.jobId !== undefined) params.set("jobId", Id.parse(query.jobId));
      if (query.cursor !== undefined) params.set("cursor", Id.parse(query.cursor));
      const limit = z
        .number()
        .int()
        .min(1)
        .max(50)
        .parse(query.limit ?? 25);
      params.set("limit", String(limit));
      const suffix = params.size ? `?${params}` : "";
      const snapshot = HardwareFleetSnapshotSchema.parse(
        await request(`/v1/managed-rl/hardware-observations${suffix}`, {
          headers: { "x-openpond-team-id": teamId },
        }),
      );
      if (
        snapshot.teamId !== teamId ||
        snapshot.workers.length > limit ||
        snapshot.workers.some(
          (worker) =>
            (query.workerId !== undefined && worker.workerId !== query.workerId) ||
            (query.jobId !== undefined && !worker.jobIds.includes(query.jobId)) ||
            (query.cursor !== undefined && worker.workerId <= query.cursor),
        ) ||
        (snapshot.nextCursor !== null && snapshot.nextCursor !== snapshot.workers.at(-1)?.workerId)
      ) {
        throw new OpenPondProtocolError(
          "hardware_observation_scope_mismatch",
          "Hardware observations do not match the requested workspace, worker or job.",
        );
      }
      return snapshot;
    },
  };
}

/** Focused read-only client; avoids loading unrelated training contracts. */
export function createHardwareObservationClient(input: TrainingTransportOptions) {
  return createTrainingHardwareClient(createTrainingRequest(input));
}
