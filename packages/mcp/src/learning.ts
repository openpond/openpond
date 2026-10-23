import { z } from "zod";
import {
  CorrectionMetricsReadSchema,
  CorrectionMetricsCommandSchema,
  GraderCatalogQuerySchema,
  GraderUsageQuerySchema,
  LearningCommandSchema,
  LearningResourceKindSchema,
  LearningRevisionRefSchema,
  LearningOperationResultSchema,
  learningResourceSchemas,
} from "openpond-sdk/learning";
import { HumanReviewCommandSchema, HumanReviewTransportSchema } from "openpond-sdk/human-review";
import type { AddTool } from "./types.js";
import type { Clients } from "./clients.js";
import { ById, Empty, Hash, Id, Revision } from "./common.js";

export function addLearning(add: AddTool, c: Clients) {
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
      const effect = action.includes("cancel")
        ? "cancel"
        : action.includes("publish")
          ? "publish"
          : action.includes("iteration")
            ? "learning"
            : action.startsWith("queue_")
              ? "execute"
              : action === "review"
                ? "review"
                : "write";
      add(
        `learning_${action}${kind ? `_${kind}` : ""}`,
        `Apply the supported ${action} learning operation. Exact operation IDs, expected revisions, pinned releases, review and spend admission remain enforced by the existing service.`,
        z.object({ command: variant }).strict(),
        effect,
        (v) => c.learning.command(LearningCommandSchema.parse(v.command)),
        {
          output: LearningOperationResultSchema,
          wireOutput: operationEnvelope,
          ...(kind === "policy" || action === "publish_resources"
            ? { scopes: ["app:publish", "app:learning"] as const }
            : {}),
        },
      );
    }
  }
  for (const kind of LearningResourceKindSchema.options) {
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
    CorrectionMetricsReadSchema,
    "read",
    (v) => c.corrections.read(v),
  );
  for (const schema of CorrectionMetricsCommandSchema.options) {
    const action = schema.shape.action.value;
    add(
      `learning_corrections_${action}`,
      `Record ${action} against exact retained correction evidence without dispatching inference or training.`,
      schema,
      "write",
      (v) => c.corrections.command(v),
    );
  }
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
  for (const schema of HumanReviewCommandSchema.options) {
    const action = schema.shape.action.value;
    add(
      `human_review_${action}`,
      `Apply the authorized ${action} human-review operation to pinned evidence and revisions.`,
      z.object({ command: schema }).strict(),
      action === "cancel" ? "cancel" : "review",
      (v) => c.human.command(v.command),
      { ...(action === "cancel" ? { scopes: ["app:review", "app:cancel"] as const } : {}) },
    );
  }
  add(
    "human_review_get",
    "Read an assigned review and optional retained revision.",
    ById.extend({ revision: Revision.optional() }),
    "read",
    (v) => c.human.get(v.id, v.revision),
  );
  add(
    "human_review_inspect",
    "Inspect a bounded page of review slots and collected judgments.",
    ById.extend({ slot: z.number().int().nonnegative().optional(), afterId: Id.optional() }),
    "read",
    ({ id, ...v }) => c.human.inspect(id, undefined, v),
  );
  const transportSchemas = HumanReviewTransportSchema.options.flatMap<z.ZodObject>((s) =>
    s instanceof z.ZodObject ? [s] : s.options,
  );
  for (const schema of transportSchemas) {
    const object: z.ZodObject = schema;
    const endpoint = object.shape.endpoint.value as string;
    if (!["inbox", "snapshot", "snapshot_tasks", "results"].includes(endpoint)) continue;
    const { endpoint: _endpoint, scope: _scope, ...fields } = object.shape;
    add(
      `human_review_${endpoint}`,
      `Read exact retained ${endpoint} evidence for authorized human review.`,
      z.object(fields).strict(),
      "read",
      (v) =>
        c.human.request(
          HumanReviewTransportSchema.parse({ ...v, endpoint, scope: c.human.options.scope }),
        ),
    );
  }
  add(
    "human_review_members",
    "Discover eligible workspace reviewers through the existing review service.",
    Empty,
    "read",
    () => c.human.members(),
  );
}
