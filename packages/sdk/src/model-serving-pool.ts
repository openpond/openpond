import { z } from "zod";

/** New serving activations use one five-minute idle window. Historical
 * requests/receipts keep their original value for exact replay and Stop. */
export const MODEL_SERVING_IDLE_TIMEOUT_SECONDS = 300;

const Id = z.string().trim().min(1).max(500);

export const TrainingServingPoolSchema = z.object({
  id: Id, provider: Id, state: z.enum(["requested", "provisioning", "ready", "degraded", "deleting", "deleted", "failed"]),
  workersMin: z.number().int().nonnegative(), workersMax: z.number().int().nonnegative(),
  idleTimeoutSeconds: z.number().int().nonnegative(), workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  endpointRecorded: z.boolean(), activeDeployments: z.number().int().nonnegative(), activeBindings: z.number().int().nonnegative(),
  activeRequests: z.number().int().nonnegative(), unsettledRequests: z.number().int().nonnegative(), retirementBlocked: z.boolean(),
}).strict();
