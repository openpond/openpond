import { z } from "zod";

const IdSchema = z.string().trim().min(1).max(500);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TimestampSchema = z.string().datetime({ offset: true });

export const ModelProjectImmutableRefSchema = z
  .object({
    id: IdSchema,
    contentHash: HashSchema,
  })
  .strict();

export const ModelProjectVersionedRefSchema =
  ModelProjectImmutableRefSchema.extend({
    revision: z.number().int().positive(),
  }).strict();

export const ModelProjectBaseModelSchema = z
  .object({
    schemaVersion: z.literal("openpond.baseModelPreference.v1"),
    modelId: IdSchema,
    revision: z.string().trim().min(1).max(256).nullable(),
    tokenizerRevision: z.string().trim().min(1).max(256).nullable(),
    chatTemplateHash: z.string().trim().min(8).max(256).nullable(),
    modelAssetId: IdSchema.nullable(),
    source: z.enum(["managed", "local", "builtin"]),
  })
  .strict();

export const ModelProjectTrainingMethodSchema = z.enum([
  "sft",
  "dpo",
  "grpo",
  "ppo",
  "sdft",
  "opd",
  "opsd",
  "sdpo",
]);

/**
 * A versioned recipe document stored while a Project is still mutable.
 * The training endpoint validates the selected recipe version in full before
 * accepting an immutable Job; Project sync preserves newer recipe fields.
 */
export const ModelProjectRecipeDocumentSchema = z
  .object({
    schemaVersion: z.string().regex(/^openpond\.[A-Za-z0-9]+Recipe\.v\d+$/),
    method: ModelProjectTrainingMethodSchema,
    parameterization: z.enum(["lora", "full"]),
  })
  .catchall(z.unknown());

export const ModelProjectTrainingSetupSchema = z
  .object({
    tasksetRef: ModelProjectVersionedRefSchema.nullable().default(null),
    tasksetRelease: ModelProjectImmutableRefSchema.nullable().default(null),
    harnessRelease: ModelProjectImmutableRefSchema.nullable().default(null),
    baseModel: ModelProjectBaseModelSchema.nullable().default(null),
    method: ModelProjectTrainingMethodSchema.nullable().default(null),
    destinationId: IdSchema.nullable().default(null),
    managedRolloutPlacement: z
      .enum(["local", "remote"])
      .default("remote"),
    runPreset: z
      .enum(["small", "standard", "custom", "small_experiment"])
      .nullable()
      .default(null),
    recipe: ModelProjectRecipeDocumentSchema.nullable().default(null),
    preferredMaximumSpendUsd: z.number().nonnegative().nullable().default(null),
    preferredRetentionDays: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .default(null),
  })
  .strict();

export const HostedModelProjectLinkSchema = z
  .object({
    schemaVersion: z.literal("openpond.hostedModelProjectLink.v1"),
    teamId: IdSchema,
    projectId: IdSchema,
    portableProjectId: IdSchema,
    revision: z.number().int().positive(),
    etag: HashSchema,
    syncedSourceRevision: z.number().int().positive(),
    syncedAt: TimestampSchema,
    tasksets: z
      .array(
        z
          .object({
            localTasksetId: IdSchema,
            releaseId: IdSchema,
            releaseRevision: z.number().int().positive(),
            releaseHash: HashSchema,
            hostedTasksetId: IdSchema,
            syncedAt: TimestampSchema,
          })
          .strict(),
      )
      .max(10_000)
      .default([]),
  })
  .strict();

export const ModelProjectTasksetSyncSchema = z
  .object({
    localTasksetId: IdSchema,
    releaseId: IdSchema,
    releaseRevision: z.number().int().positive(),
    releaseHash: HashSchema,
    state: z.enum(["syncing", "synced", "sync_failed"]),
    hostedTasksetId: IdSchema.nullable().default(null),
    lastAttemptAt: TimestampSchema,
    syncedAt: TimestampSchema.nullable().default(null),
    lastError: z.string().trim().min(1).max(5_000).nullable().default(null),
  })
  .strict();

export const ModelProjectSchema = z
  .object({
    schemaVersion: z.literal("openpond.modelProject.v2"),
    id: IdSchema,
    profileId: IdSchema,
    revision: z.number().int().positive().default(1),
    name: z.string().trim().min(1).max(200),
    objective: z.string().trim().max(5_000).nullable(),
    defaultBaseModel: ModelProjectBaseModelSchema.nullable(),
    defaultDestinationId: IdSchema.nullable(),
    trainingSetup: ModelProjectTrainingSetupSchema,
    hosted: HostedModelProjectLinkSchema.nullable().default(null),
    tasksetSyncs: z
      .array(ModelProjectTasksetSyncSchema)
      .max(10_000)
      .default([]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const HostedModelProjectSyncSchema = z
  .object({
    schemaVersion: z.literal("openpond.hostedModelProjectSync.v2"),
    portableProjectId: IdSchema,
    name: z.string().trim().min(1).max(200),
    objective: z.string().trim().max(5_000).nullable(),
    defaultBaseModel: ModelProjectBaseModelSchema.nullable(),
    defaultDestinationId: IdSchema.nullable(),
    trainingSetup: ModelProjectTrainingSetupSchema,
    sourceRevision: z.number().int().positive(),
    sourceUpdatedAt: TimestampSchema,
    expectedEtag: HashSchema.nullable().default(null),
  })
  .strict();

export const HostedModelProjectSummarySchema = z
  .object({
    id: IdSchema,
    teamId: IdSchema,
    portableProjectId: IdSchema,
    name: z.string().trim().min(1).max(200),
    objective: z.string().trim().max(5_000).nullable(),
    defaultBaseModel: ModelProjectBaseModelSchema.nullable(),
    defaultDestinationId: IdSchema.nullable(),
    trainingSetup: ModelProjectTrainingSetupSchema,
    sourceRevision: z.number().int().positive(),
    sourceUpdatedAt: TimestampSchema,
    revision: z.number().int().positive(),
    etag: HashSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const ModelProjectResourceSummarySchema = z
  .object({
    kind: z.enum([
      "taskset_release",
      "harness_release",
      "dataset_release",
      "evidence_set",
      "model_version",
      "reward_model_version",
      "evaluation_receipt",
    ]),
    ref: ModelProjectImmutableRefSchema,
    role: z.string().trim().min(1).max(200).nullable().default(null),
    updatedAt: TimestampSchema,
  })
  .strict();

export const HostedModelProjectDetailSchema = z
  .object({
    project: HostedModelProjectSummarySchema,
    resources: z.array(ModelProjectResourceSummarySchema).max(10_000),
    jobCount: z.number().int().nonnegative(),
    latestJobIds: z.array(IdSchema).max(100),
  })
  .strict();

export type ModelProject = z.infer<typeof ModelProjectSchema>;
export type ModelProjectTrainingSetup = z.infer<
  typeof ModelProjectTrainingSetupSchema
>;
export type HostedModelProjectSync = z.infer<
  typeof HostedModelProjectSyncSchema
>;
export type HostedModelProjectSummary = z.infer<
  typeof HostedModelProjectSummarySchema
>;
export type HostedModelProjectDetail = z.infer<
  typeof HostedModelProjectDetailSchema
>;

type ModelProjectsFetch = typeof fetch;

export function createModelProjectsClient(input: {
  baseUrl: string;
  fetch?: ModelProjectsFetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
}) {
  const fetchImpl = input.fetch ?? fetch;
  const baseUrl = input.baseUrl.replace(/\/$/, "");

  async function request(pathname: string, init?: RequestInit): Promise<unknown> {
    const configuredHeaders =
      typeof input.headers === "function"
        ? await input.headers()
        : (input.headers ?? {});
    const response = await fetchImpl(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...Object.fromEntries(new Headers(configuredHeaders)),
        ...Object.fromEntries(new Headers(init?.headers)),
      },
    });
    const body = (await response.json()) as unknown;
    if (!response.ok) {
      const message =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : `Model Project request failed with HTTP ${response.status}.`;
      throw new Error(message);
    }
    return body;
  }

  return {
    async upsert(project: HostedModelProjectSync) {
      const parsed = HostedModelProjectSyncSchema.parse(project);
      const body = await request(
        `/v1/model-projects/${encodeURIComponent(parsed.portableProjectId)}`,
        { method: "PUT", body: JSON.stringify(parsed) },
      );
      return HostedModelProjectSummarySchema.parse(
        unwrapObject(body, "project"),
      );
    },
    async list() {
      const body = await request("/v1/model-projects");
      return z
        .array(HostedModelProjectSummarySchema)
        .parse(unwrapObject(body, "projects"));
    },
    async get(projectId: string) {
      const body = await request(
        `/v1/model-projects/${encodeURIComponent(IdSchema.parse(projectId))}`,
      );
      return HostedModelProjectDetailSchema.parse(body);
    },
  };
}

function unwrapObject(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return key in value ? (value as Record<string, unknown>)[key] : value;
}
