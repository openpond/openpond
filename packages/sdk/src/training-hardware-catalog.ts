import { z } from "zod";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const OpaqueIdentifier = z.string().min(1).max(191).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

/** Hardware metadata never quotes stock, price, or permission to start work. */
export const TrainingHardwareSpecificationSchema = z.object({
  id: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(256),
  manufacturer: z.string().trim().min(1).max(100),
  memoryGb: z.number().int().positive(),
  secureCloud: z.boolean(),
  communityCloud: z.boolean(),
  maximumPerPod: z.object({
    secure: z.number().int().nonnegative(),
    community: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export type TrainingHardwareSpecification = z.infer<typeof TrainingHardwareSpecificationSchema>;

export const TrainingHardwareInventorySchema = z.object({
  schemaVersion: z.literal("openpond.trainingHardwareInventory.v1"),
  provider: OpaqueIdentifier,
  source: OpaqueIdentifier,
  version: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: z.iso.datetime(),
  refreshAfter: z.iso.datetime(),
  hardware: z.array(TrainingHardwareSpecificationSchema).max(1000),
}).strict();
export type TrainingHardwareInventory = z.infer<typeof TrainingHardwareInventorySchema>;

export const TrainingHardwareCatalogSchema = z.object({
  schemaVersion: z.literal("openpond.trainingHardwareCatalog.v1"),
  inventory: TrainingHardwareInventorySchema,
  workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  eligibility: z.array(z.object({
    gpuTypeId: z.string().min(1).max(256),
    status: z.enum(["requires_live_workload_check", "not_admitted"]),
    reason: z.enum(["candidate_for_current_runtime", "gpu_type_not_enabled", "secure_pods_unavailable", "insufficient_memory"]),
  }).strict()).max(1000),
}).strict();
export type TrainingHardwareCatalog = z.infer<typeof TrainingHardwareCatalogSchema>;

export async function parseAndVerifyTrainingHardwareInventory(raw: unknown) {
  const inventory = TrainingHardwareInventorySchema.parse(raw);
  const { version, observedAt, refreshAfter, ...content } = inventory;
  if (version !== await canonicalSha256(content) ||
      Date.parse(refreshAfter) <= Date.parse(observedAt) ||
      new Set(inventory.hardware.map(item => item.id)).size !== inventory.hardware.length)
    throw new OpenPondProtocolError("training_hardware_inventory_mismatch", "Hardware metadata could not be verified.");
  return inventory;
}

export async function parseAndVerifyTrainingHardwareCatalog(raw: unknown) {
  const catalog = TrainingHardwareCatalogSchema.parse(raw);
  await parseAndVerifyTrainingHardwareInventory(catalog.inventory);
  const ids = new Set(catalog.inventory.hardware.map(item => item.id));
  if (catalog.eligibility.length !== ids.size ||
      new Set(catalog.eligibility.map(item => item.gpuTypeId)).size !== ids.size ||
      catalog.eligibility.some(item => !ids.has(item.gpuTypeId) ||
        (item.status === "requires_live_workload_check") !== (item.reason === "candidate_for_current_runtime")))
    throw new OpenPondProtocolError("training_hardware_catalog_mismatch", "Hardware eligibility does not match its inventory.");
  return catalog;
}

export function createTrainingHardwareCatalogClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {
    async hardwareCatalog() {
      return parseAndVerifyTrainingHardwareCatalog(await request("/v1/training/hardware-catalog"));
    },
  };
}
