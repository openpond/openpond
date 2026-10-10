import { z } from "zod";
import { TasksetDraftWorkspaceSchema } from "openpond-sdk/taskset-drafts";

const Id = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const LocalDatasetCheckSchema = z.object({
  kind: z.enum(["structure", "graders"]), revision: z.number().int().positive(), workspaceHash: Hash,
  status: z.enum(["passed", "failed", "unavailable"]), checkedAt: z.iso.datetime(),
  checked: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
  issues: z.array(z.object({ code: z.string(), message: z.string(), taskId: Id.optional(), graderId: Id.optional() })).max(10_000),
  scopes: z.array(z.object({graderId:Id,checked:z.number().int().nonnegative(),total:z.number().int().nonnegative(),status:z.enum(["passed","failed","unavailable"])}).strict()).max(1000).optional(),
}).strict();
export const DatasetSyncLinkSchema = z.object({
  apiOrigin: z.url(), actorId: Id, teamId: Id, datasetId: Id, remoteRevision: z.number().int().nonnegative(),
  acknowledgedHash: Hash.nullable(), remoteHash: Hash.nullable(), pendingLocalHash: Hash.nullable(), paused: z.boolean(),
  status: z.enum(["pending", "syncing", "synced", "retry", "conflict", "paused"]),
  error: z.string().nullable(), operationId: Id.nullable(), pendingWorkspace: TasksetDraftWorkspaceSchema.nullable(),
  beginVersionOperationId:Id.nullable().optional(),
  publicationIntent:z.object({operationId:Id,expectedRevision:z.number().int().positive(),workspaceHash:Hash,packageHash:Hash,localHash:Hash}).strict().nullable().optional(),
}).strict();
export const LocalDatasetRecordSchema = z.object({
  schemaVersion: z.literal("openpond.localDataset.v1"), ownerId: Id, projectId: Id.nullable(),
  workspace: TasksetDraftWorkspaceSchema, checks: z.array(LocalDatasetCheckSchema).max(2),
  packageHash: Hash.nullable(), sync: DatasetSyncLinkSchema.nullable(),
}).strict();
export type LocalDatasetRecord = z.infer<typeof LocalDatasetRecordSchema>;
export type LocalDatasetCheck = z.infer<typeof LocalDatasetCheckSchema>;

export const ChatResourceSummarySchema = z.object({
  kind: z.enum(["dataset", "grader", "experiment"]), id: Id, revision: z.number().int().positive(),
  name: z.string().max(500), state: z.string().max(100), datasetId: Id.optional(), datasetRevision: z.number().int().positive().optional(),
  taskCount: z.number().int().nonnegative().optional(), graderCount: z.number().int().nonnegative().optional(),
  checkState: z.string().optional(), syncState: z.string().optional(), model: z.string().optional(),
  graderId:Id.optional(),graderType:z.string().optional(),description:z.string().optional(),
  location:z.enum(["local","cloud"]).optional(),scoreLabel:z.string().optional(),
  score: z.number().nullable().optional(), costUsd: z.number().nonnegative().nullable().optional(),
  evaluatedCount: z.number().int().nonnegative().optional(), failedCount: z.number().int().nonnegative().optional(),
  qualityFailureCount:z.number().int().nonnegative().optional(),executionFailureCount:z.number().int().nonnegative().optional(),ungradedCount:z.number().int().nonnegative().optional(),
  rows: z.array(z.object({ id: Id, label: z.string(), detail: z.string(), score: z.number().nullable().optional() })).max(10),
}).strict();
export type ChatResourceSummary = z.infer<typeof ChatResourceSummarySchema>;

export const LocalDatasetRequestSchema = z.object({
  action: z.enum(["schema", "list", "read", "create", "save", "file", "validate", "check_graders", "check_sources", "package", "import", "inspect_source", "import_source", "upload", "sync", "pause_sync", "disconnect_sync", "related_chats", "list_graders", "read_grader", "save_grader", "test_grader", "publish"]),
  id: Id.optional(), operationId: Id.optional(), expectedRevision: z.number().int().nonnegative().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const ChatExperimentViewSchema=z.object({
  contentHash:Hash,scope:z.string(),graders:z.unknown(),cases:z.array(z.object({id:Id,taskId:Id,seed:z.string(),status:z.string(),output:z.string().nullable(),error:z.string().nullable(),score:z.number().nullable()}).strict()).max(10_000),
}).strict();
export type ChatExperimentView=z.infer<typeof ChatExperimentViewSchema>;
