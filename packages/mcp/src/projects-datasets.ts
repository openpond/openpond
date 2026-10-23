import { z } from "zod";
import {
  TrainingProjectWriteSchema,
  TrainingProjectArchiveSchema,
  TrainingProjectSchema,
  TrainingProjectListSchema,
} from "openpond-sdk/training-projects";
import {
  DatasetWorkspaceListQuerySchema,
  DatasetWorkspaceWriteSchema,
  DatasetWorkspaceReceiptSchema,
  DatasetWorkspacePublishSchema,
  DatasetWorkspaceBeginVersionSchema,
  DatasetWorkspaceOperationKindSchema,
  DatasetPreparationCreateSchema,
  DatasetPreparationCommandSchema,
  DatasetPreparationGrantCreateSchema,
} from "openpond-sdk/dataset-workspaces";
import {
  TasksetCatalogQuerySchema,
  TasksetCatalogReleaseRefSchema,
} from "openpond-sdk/taskset-catalog";
import { TasksetPackagePublicationSchema } from "openpond-sdk/taskset-packages";
import type { AddTool } from "./types.js";
import type { Clients } from "./clients.js";
import { ById, Cursor, Id, Revision } from "./common.js";

export function addProjectsAndDatasets(add: AddTool, c: Clients) {
  add(
    "projects_list",
    "List authorized hosted Projects. Continue using the returned cursor.",
    Cursor,
    "read",
    (v) => c.projects.list(v),
    { output: TrainingProjectListSchema },
  );
  add(
    "projects_get",
    "Read a Project and its exact revision.",
    ById,
    "read",
    (v) => c.projects.get(v.id),
    { output: TrainingProjectSchema },
  );
  add(
    "projects_save",
    "Create or update a Project using its expected revision and retained operation identity.",
    TrainingProjectWriteSchema,
    "write",
    (v) => c.projects.save(v),
    { output: TrainingProjectSchema },
  );
  add(
    "projects_archive",
    "Archive or restore a Project with compare-and-swap revision control.",
    TrainingProjectArchiveSchema.extend({ id: Id }),
    "write",
    ({ id, ...v }) => c.projects.archive(id, v),
    { output: TrainingProjectSchema },
  );
  add(
    "datasets_list",
    "Discover hosted dataset authoring workspaces, optionally within a Project.",
    DatasetWorkspaceListQuerySchema,
    "read",
    (v) => c.datasets.list(v),
  );
  add(
    "datasets_get",
    "Read the current dataset workspace, source identity, revision and publication.",
    ById,
    "read",
    (v) => c.datasets.get(v.id),
    { output: DatasetWorkspaceReceiptSchema },
  );
  add(
    "datasets_save",
    "Create or save exact dataset workspace bytes. Keep operationId and expectedRevision unchanged on a lost-response retry.",
    DatasetWorkspaceWriteSchema,
    "write",
    (v) => c.datasets.save(v),
    { output: DatasetWorkspaceReceiptSchema },
  );
  add(
    "datasets_validate",
    "Validate a dataset revision without publishing or launching it.",
    ById.extend({ expectedRevision: Revision }),
    "write",
    (v) => c.datasets.validate(v.id, v.expectedRevision),
  );
  add(
    "datasets_publish",
    "Publish an immutable validated dataset release pinned to workspaceHash and packageHash.",
    DatasetWorkspacePublishSchema.extend({ id: Id }),
    "publish",
    ({ id, ...v }) => c.datasets.publish(id, v),
  );
  add(
    "datasets_begin_version",
    "Begin a new editable version from an exact published dataset revision.",
    DatasetWorkspaceBeginVersionSchema.extend({ id: Id }),
    "write",
    ({ id, ...v }) => c.datasets.beginVersion(id, v),
  );
  add(
    "datasets_versions",
    "Read bounded immutable dataset version history.",
    ById.extend({ beforeRevision: Revision.optional() }),
    "read",
    ({ id, ...v }) => c.datasets.versions(id, v),
  );
  add(
    "datasets_version",
    "Read an exact immutable published dataset workspace revision.",
    ById.extend({ revision: Revision }),
    "read",
    (v) => c.datasets.version(v.id, v.revision),
  );
  add(
    "datasets_operation",
    "Recover this actor's retained dataset operation. Never allocate a replacement identity after an uncertain write.",
    z
      .object({
        operationId: Id,
        datasetId: Id.optional(),
        kind: DatasetWorkspaceOperationKindSchema,
        requestHash: z.string().optional(),
      })
      .strict(),
    "read",
    ({ operationId, ...v }) => c.datasets.operationResult(operationId, v),
  );
  add(
    "tasksets_list",
    "List released dataset/taskset catalog entries with immutable references.",
    TasksetCatalogQuerySchema,
    "read",
    (v) => c.tasksets.list(v),
  );
  add(
    "tasksets_get",
    "Inspect a released taskset catalog entry by hosted identity.",
    ById,
    "read",
    (v) => c.tasksets.get(v.id),
  );
  add(
    "tasksets_resolve",
    "Resolve an exact dataset release ID, revision and content hash.",
    TasksetCatalogReleaseRefSchema,
    "read",
    (v) => c.tasksets.resolve(v),
  );
  const target = z.object({ datasetId: Id }).strict();
  add(
    "dataset_preparations_list",
    "List retained preparation runs for one dataset.",
    target.extend({ cursor: Id.optional() }),
    "read",
    ({ datasetId, ...v }) => c.datasets.preparations.list(datasetId, v),
  );
  add(
    "dataset_preparations_get",
    "Read a preparation run, approvals, progress and accounting.",
    target.extend({ runId: Id }),
    "read",
    (v) => c.datasets.preparations.get(v.datasetId, v.runId),
  );
  add(
    "dataset_preparations_create",
    "Create an authorized bounded preparation intent using an existing grant. May incur spend under that grant.",
    target.extend({ request: DatasetPreparationCreateSchema }),
    "execute",
    (v) => c.datasets.preparations.create(v.datasetId, v.request),
  );
  add(
    "dataset_preparation_grants_create",
    "Create the explicit bounded dataset preparation resource/spend grant; this does not start preparation.",
    target.extend({ request: DatasetPreparationGrantCreateSchema }),
    "execute",
    (v) => c.datasets.preparations.createGrant(v.datasetId, v.request),
  );
  add(
    "dataset_preparation_grants_get",
    "Inspect a preparation grant and its exact limits.",
    target.extend({ grantId: Id }),
    "read",
    (v) => c.datasets.preparations.getGrant(v.datasetId, v.grantId),
  );
  add(
    "dataset_preparations_candidates",
    "Read a bounded page of prepared candidate examples and qualification evidence.",
    target.extend({ runId: Id, cursor: Id.optional() }),
    "read",
    ({ datasetId, runId, ...v }) => c.datasets.preparations.candidates(datasetId, runId, v),
  );
  add(
    "dataset_preparations_operation",
    "Recover a preparation operation by its original operation identity without resubmitting work.",
    target.extend({ operationId: Id }),
    "read",
    (v) => c.datasets.preparations.operationResult(v.datasetId, v.operationId),
  );
  add(
    "taskset_packages_publish",
    "Publish exact authorized portable taskset package bytes using the existing immutable package contract; accepts hosted/uploaded content, never a local path.",
    TasksetPackagePublicationSchema,
    "publish",
    (v) => c.packages.publish(v),
  );
  add(
    "taskset_packages_get",
    "Retrieve an exact immutable taskset package release with an optional expected package hash.",
    z
      .object({
        release: TasksetCatalogReleaseRefSchema,
        expectedPackageHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict(),
    "read",
    (v) => c.packages.getByRelease(v.release, { expectedPackageHash: v.expectedPackageHash }),
  );
  // The command union has stable action discriminants. Register each action
  // separately so clients can see side effects instead of a generic executor.
  for (const schema of DatasetPreparationCommandSchema.options) {
    const actions =
      "options" in schema.shape.action ? schema.shape.action.options : [schema.shape.action.value];
    for (const action of actions) {
      add(
        `dataset_preparations_${action}`,
        `Apply ${action} to the retained dataset preparation; start/resume/release may publish the approved private version. Exact revision, operation identity and preparation budget remain enforced.`,
        target.extend({ runId: Id, command: schema.extend({ action: z.literal(action) }) }),
        ["cancel", "pause"].includes(action)
          ? "cancel"
          : action === "release"
            ? "publish"
            : action.includes("start") || action.includes("resume")
              ? "execute"
              : "write",
        (v) =>
          c.datasets.preparations.command(
            v.datasetId,
            v.runId,
            DatasetPreparationCommandSchema.parse(v.command),
          ),
        ["start", "resume", "release"].includes(action)
          ? { scopes: ["app:execute", "app:publish"] }
          : {},
      );
    }
  }
}
