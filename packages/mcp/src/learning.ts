import { z } from "zod";
import {
  CorrectionMetricsReadSchema,
  GraderCatalogQuerySchema,
  GraderUsageQuerySchema,
  LearningCommandSchema,
  LearningRevisionRefSchema,
  LearningOperationResultSchema,
  learningResourceSchemas,
  TaskIntakeFormatSchema,
  TaskIntakeFileSchema,
  TaskIntakePreviewSchema,
  previewTaskIntake,
} from "openpond-sdk/learning";
import type { AddTool } from "./types.js";
import type { Clients } from "./clients.js";
import { ById, Hash, Id, Revision, withoutWorkspace } from "./common.js";
import {
  TRAINING_LEARNING_ACTIONS,
  TRAINING_LEARNING_KINDS,
  TRAINING_LEARNING_PUBLISH_KINDS,
} from "./training-learning-policy.js";

export function addLearning(add: AddTool, c: Clients, teamId: string) {
  add(
    "learning_preview_intake",
    "Preview bounded JSON/JSONL/CSV or supported agent-history text before importing it into training review. Paths label supplied text and never read a filesystem. Use contentHash as expectedPreviewHash and retain reviewed record IDs for learning_import_intake; previewing grants no training permission.",
    z
      .object({
        format: TaskIntakeFormatSchema,
        files: z.array(TaskIntakeFileSchema).min(1).max(100),
      })
      .strict(),
    "read",
    async (v) => previewTaskIntake(v),
    { output: TaskIntakePreviewSchema },
  );
  // Wire discovery advertises a compact identity envelope; the full SDK schema
  // still validates every returned resource before any result is emitted. Full
  // retained evidence remains in `result`, unchanged. Repeating the entire
  // polymorphic resource union on every command otherwise dominates discovery.
  const resourceIdentity = z
    .object({
      id: Id,
      schemaVersion: z.string().optional(),
      revision: Revision.optional(),
      contentHash: Hash.optional(),
    })
    .passthrough();
  const operationEnvelope = z
    .object({ operationId: Id, resources: z.array(resourceIdentity).max(100) })
    .strict();
  // Each public command is a separate discoverable MCP tool. Nested discriminated
  // unions (for publication kinds) remain typed inputs to that named operation.
  for (const schema of LearningCommandSchema.options) {
    const variants = "options" in schema ? schema.options : [schema];
    for (const variant of variants) {
      const action = variant.shape.action.value as string;
      const kind = "kind" in variant.shape ? variant.shape.kind.value : undefined;
      if (
        !(action in TRAINING_LEARNING_ACTIONS) ||
        (action === "publish" && !TRAINING_LEARNING_PUBLISH_KINDS.some((value) => value === kind))
      )
        continue;
      const effect = TRAINING_LEARNING_ACTIONS[action as keyof typeof TRAINING_LEARNING_ACTIONS];
      add(
        `learning_${action}${kind ? `_${kind}` : ""}`,
        `Apply the supported ${action} learning operation. Exact operation IDs, expected revisions, pinned releases, review and spend admission remain enforced by the existing service.`,
        z.object({ command: variant }).strict(),
        effect,
        (v) => c.learning.command(LearningCommandSchema.parse(v.command)),
        {
          output: LearningOperationResultSchema,
          wireOutput: operationEnvelope,
          scopes:
            action === "publish" && kind === "policy"
              ? ["app:publish", "app:learning"]
              : [`app:${effect}`],
        },
      );
    }
  }
  for (const kind of TRAINING_LEARNING_KINDS) {
    add(
      `learning_${kind}_get`,
      `Read an exact ${kind} learning resource and optional immutable revision.`,
      ById.extend({ revision: Revision.optional() }),
      "read",
      (v) => c.learning.get(kind, v.id, v.revision),
      { output: learningResourceSchemas[kind], wireOutput: resourceIdentity },
    );
    add(
      `learning_${kind}_list`,
      `List a bounded page of authorized ${kind} resources.`,
      z
        .object({
          parentId: Id.optional(),
          status: z.string().min(1).max(200).optional(),
          reviewState: z.enum(["inbox", "reviewed"]).optional(),
          afterId: Id.optional(),
          limit: z.number().int().min(1).max(100).default(30),
        })
        .strict(),
      "read",
      (v) => c.learning.list(kind, v),
    );
  }
  add(
    "learning_correction_metrics",
    "Read one Model/run correction verification snapshot; never creates a grade, training run or policy.",
    withoutWorkspace(CorrectionMetricsReadSchema),
    "read",
    (v) => c.corrections.read({ ...v, teamId }),
  );
  add(
    "graders_catalog",
    "Discover released graders with authorized Project, dataset and run usage counts.",
    GraderCatalogQuerySchema,
    "read",
    (v) => c.graders.catalog(v),
  );
  add(
    "graders_versions",
    "Read immutable grader releases in descending revision order.",
    ById.extend({
      beforeRevision: Revision.optional(),
      limit: z.number().int().min(1).max(100).default(25),
    }),
    "read",
    ({ id, ...v }) => c.graders.versions(id, v),
  );
  add(
    "graders_usage",
    "Inspect a bounded page of authorized Projects, datasets or runs consuming one grader.",
    GraderUsageQuerySchema.extend({ id: Id }),
    "read",
    ({ id, ...v }) => c.graders.usage(id, v),
  );
  add(
    "learning_inspect_evidence",
    "Inspect exact retained task evidence, grades and review eligibility.",
    LearningRevisionRefSchema,
    "read",
    (v) => c.learning.inspectEvidence(v),
  );
  add(
    "learning_inspect_policy",
    "Inspect current eligibility and budget of an exact policy revision without reserving an iteration.",
    LearningRevisionRefSchema,
    "read",
    (v) => c.learning.inspectPolicy(v),
  );
  add(
    "learning_inspect_queue",
    "Read shared task eligibility and budget without launching or reserving work.",
    z.object({ modelProjectId: Id.nullable().default(null) }).strict(),
    "read",
    (v) => c.learning.inspectTaskQueue(v.modelProjectId),
  );
  add(
    "learning_publish_batch",
    "Publish a sealed batch as an immutable Model taskset package without starting training.",
    z.object({ batchId: Id, modelProjectId: Id }).strict(),
    "publish",
    (v) => c.learning.publishBatch(v),
  );
}
