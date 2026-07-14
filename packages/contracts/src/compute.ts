import { z } from "zod";

const IdSchema = z.string().trim().min(1).max(240);
const TimestampSchema = z.string().trim().datetime({ offset: true });
const ByteCountSchema = z.number().int().nonnegative();
const OptionalByteCountSchema = ByteCountSchema.nullable();

export const ComputePlatformSchema = z.enum(["darwin", "linux", "win32", "other"]);
export const ComputeDeviceKindSchema = z.enum(["cpu", "gpu", "accelerator"]);
export const ComputeVendorSchema = z.enum(["apple", "nvidia", "amd", "intel", "other"]);
export const ComputeProbeStateSchema = z.enum(["available", "unavailable", "error"]);
export const ComputeRuntimeKindSchema = z.enum([
  "python",
  "trl_peft",
  "mlx",
  "cuda",
  "rocm",
  "ollama",
  "docker",
  "podman",
]);

export const ComputeDeviceSchema = z.object({
  id: IdSchema,
  kind: ComputeDeviceKindSchema,
  vendor: ComputeVendorSchema,
  index: z.number().int().nonnegative().nullable(),
  name: z.string().trim().min(1).max(500),
  totalMemoryBytes: OptionalByteCountSchema,
  freeMemoryBytes: OptionalByteCountSchema,
  physicalCoreCount: z.number().int().positive().nullable(),
  logicalCoreCount: z.number().int().positive().nullable(),
  driverVersion: z.string().trim().min(1).max(200).nullable(),
  runtimeVersion: z.string().trim().min(1).max(200).nullable(),
  computeCapability: z.string().trim().min(1).max(100).nullable(),
  supportedPrecisions: z.array(z.enum(["fp32", "fp16", "bf16", "tf32", "int8", "int4"])),
  available: z.boolean(),
  unavailableReason: z.string().trim().min(1).max(2_000).nullable(),
});

export const ComputeRuntimeSchema = z.object({
  id: IdSchema,
  kind: ComputeRuntimeKindSchema,
  state: ComputeProbeStateSchema,
  version: z.string().trim().min(1).max(200).nullable(),
  executable: z.string().trim().min(1).max(4_000).nullable(),
  detail: z.string().trim().min(1).max(2_000).nullable(),
});

export const ComputeStorageRootSchema = z.object({
  id: IdSchema,
  label: z.string().trim().min(1).max(500),
  path: z.string().trim().min(1).max(4_000),
  modelStorePath: z.string().trim().min(1).max(4_000),
  kind: z.enum(["local", "network", "removable", "cache"]),
  configured: z.boolean(),
  mounted: z.boolean(),
  writable: z.boolean(),
  totalBytes: OptionalByteCountSchema,
  freeBytes: OptionalByteCountSchema,
});

export const ComputeConnectionRefSchema = z.object({
  id: IdSchema,
  kind: z.enum(["local", "ssh", "managed", "custom"]),
  label: z.string().trim().min(1).max(500),
  configured: z.boolean(),
  available: z.boolean(),
  lastCheckedAt: TimestampSchema.nullable(),
  unavailableReason: z.string().trim().min(1).max(2_000).nullable(),
});

export const ModelAssetSourceSchema = z.enum(["huggingface", "mlx", "ollama", "local"]);
export const ModelAssetSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(500),
  source: ModelAssetSourceSchema,
  path: z.string().trim().min(1).max(4_000).nullable(),
  modelId: z.string().trim().min(1).max(500).nullable(),
  revision: z.string().trim().min(1).max(256).nullable(),
  tokenizerRevision: z.string().trim().min(1).max(256).nullable(),
  chatTemplateHash: z.string().trim().regex(/^[a-f0-9]{64}$/).nullable(),
  digest: z.string().trim().min(8).max(256).nullable(),
  family: z.string().trim().min(1).max(200).nullable(),
  parameterCount: z.number().int().positive().nullable(),
  format: z.enum(["safetensors", "pytorch", "mlx", "gguf", "unknown"]),
  quantization: z.string().trim().min(1).max(100).nullable(),
  sizeBytes: OptionalByteCountSchema,
  inferenceCompatible: z.boolean(),
  trainingCompatible: z.boolean(),
  compatibilityReason: z.string().trim().min(1).max(2_000).nullable(),
  discoveredAt: TimestampSchema,
});

export const ModelDownloadStatusSchema = z.enum(["queued", "downloading", "verifying", "succeeded", "cancelling", "cancelled", "failed"]);
export const ModelDownloadJobSchema = z.object({
  schemaVersion: z.literal("openpond.modelDownload.v1"),
  id: IdSchema,
  modelId: IdSchema,
  revision: z.string().trim().min(8).max(256),
  license: z.string().trim().min(1).max(200),
  destinationPath: z.string().trim().min(1).max(4_000),
  expectedBytes: ByteCountSchema,
  downloadedBytes: ByteCountSchema,
  status: ModelDownloadStatusSchema,
  error: z.string().trim().min(1).max(20_000).nullable(),
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const ComputeHostProfileSchema = z.object({
  platform: ComputePlatformSchema,
  architecture: z.string().trim().min(1).max(100),
  operatingSystem: z.string().trim().min(1).max(500),
  hostname: z.string().trim().min(1).max(500),
  totalMemoryBytes: OptionalByteCountSchema,
});

export const ComputeSettingsSchema = z.object({
  schemaVersion: z.literal("openpond.computeSettings.v1"),
  modelStorePath: z.string().trim().min(1).max(4_000).nullable(),
  defaultDeviceIds: z.array(IdSchema).max(64),
  additionalModelPaths: z.array(z.string().trim().min(1).max(4_000)).max(32),
  updatedAt: TimestampSchema,
});

export const ComputeInventorySchema = z.object({
  schemaVersion: z.literal("openpond.computeInventory.v1"),
  host: ComputeHostProfileSchema,
  devices: z.array(ComputeDeviceSchema),
  runtimes: z.array(ComputeRuntimeSchema),
  storageRoots: z.array(ComputeStorageRootSchema),
  connections: z.array(ComputeConnectionRefSchema),
  models: z.array(ModelAssetSchema),
  downloads: z.array(ModelDownloadJobSchema),
  warnings: z.array(z.string().trim().min(1).max(2_000)).max(100),
  scannedAt: TimestampSchema,
});

export const ComputeCompatibilityIssueSchema = z.object({
  code: IdSchema,
  severity: z.enum(["warning", "error"]),
  message: z.string().trim().min(1).max(2_000),
});

export const ComputeCompatibilityReportSchema = z.object({
  schemaVersion: z.literal("openpond.computeCompatibility.v1"),
  compatible: z.boolean(),
  deviceIds: z.array(IdSchema),
  modelAssetId: IdSchema.nullable(),
  runtimeIds: z.array(IdSchema),
  estimatedMemoryBytes: OptionalByteCountSchema,
  estimatedStorageBytes: OptionalByteCountSchema,
  issues: z.array(ComputeCompatibilityIssueSchema),
  checkedAt: TimestampSchema,
});

export const ComputeStateResponseSchema = z.object({
  schemaVersion: z.literal("openpond.computeState.v1"),
  settings: ComputeSettingsSchema,
  inventory: ComputeInventorySchema.nullable(),
  scanning: z.boolean(),
});

export const UpdateComputeSettingsRequestSchema = z.object({
  modelStorePath: z.string().trim().min(1).max(4_000).nullable().optional(),
  defaultDeviceIds: z.array(IdSchema).max(64).optional(),
  additionalModelPaths: z.array(z.string().trim().min(1).max(4_000)).max(32).optional(),
});

export type ComputeDevice = z.infer<typeof ComputeDeviceSchema>;
export type ComputeRuntime = z.infer<typeof ComputeRuntimeSchema>;
export type ComputeStorageRoot = z.infer<typeof ComputeStorageRootSchema>;
export type ComputeConnectionRef = z.infer<typeof ComputeConnectionRefSchema>;
export type ModelAsset = z.infer<typeof ModelAssetSchema>;
export type ModelDownloadJob = z.infer<typeof ModelDownloadJobSchema>;
export type ComputeHostProfile = z.infer<typeof ComputeHostProfileSchema>;
export type ComputeSettings = z.infer<typeof ComputeSettingsSchema>;
export type ComputeInventory = z.infer<typeof ComputeInventorySchema>;
export type ComputeCompatibilityReport = z.infer<typeof ComputeCompatibilityReportSchema>;
export type ComputeStateResponse = z.infer<typeof ComputeStateResponseSchema>;
