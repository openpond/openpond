import { z } from "zod";

import {
  ImmutableReleaseRefSchema, ReleaseHashSchema, ReleaseIdSchema, contentHash,
  harnessSourcePackageFiles, loadReleasedProfileWorkflowCatalogAssets, sha256,
  validateHarnessSourcePackage, type AgentSnapshot, type HarnessRelease,
} from "@openpond/harness";
import { TaskSplitSchema } from "./tasksets.js";

const RelativePathSchema = z.string().min(1).max(2_000).refine((value) =>
  !value.includes("\\") && !value.includes(":") && !value.startsWith("/")
  && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  "evaluation paths must be portable and relative",
);

/** Portable selection only. Taskset releases own task data and graders; run
 * manifests and evidence stay in the installation's evaluation store. */
export const ProfileEvaluationTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("profile") }).strict(),
  z.object({ kind: z.literal("workflow"), workflowId: ReleaseIdSchema }).strict(),
  z.object({ kind: z.literal("skill"), skillPath: RelativePathSchema }).strict(),
  z.object({ kind: z.literal("agent_action"), actionId: ReleaseIdSchema }).strict(),
]);

export const ProfileEvaluationDefinitionSchema = z.object({
  id: ReleaseIdSchema,
  label: z.string().trim().min(1).max(240),
  description: z.string().max(4_000),
  target: ProfileEvaluationTargetSchema,
  tasksetRelease: ImmutableReleaseRefSchema,
  split: TaskSplitSchema,
  taskIds: z.array(ReleaseIdSchema).min(1).max(100_000),
  seeds: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
  criterion: z.object({
    minimumPassRate: z.number().min(0).max(1),
    requireComplete: z.boolean(),
  }).strict(),
}).strict().superRefine((definition, context) => {
  if (new Set(definition.taskIds).size !== definition.taskIds.length) {
    context.addIssue({ code: "custom", path: ["taskIds"], message: "Evaluation task identities must be unique." });
  }
  if (new Set(definition.seeds).size !== definition.seeds.length) {
    context.addIssue({ code: "custom", path: ["seeds"], message: "Evaluation seeds must be unique." });
  }
});

export const ProfileEvaluationSuiteSchema = z.object({
  id: ReleaseIdSchema,
  label: z.string().trim().min(1).max(240),
  scope: z.enum(["component", "profile"]),
  definitionIds: z.array(ReleaseIdSchema).min(1).max(1_000),
}).strict();

export const ProfileEvaluationCatalogSchema = z.object({
  schemaVersion: z.literal("openpond.profileEvaluations.v1"),
  definitions: z.array(ProfileEvaluationDefinitionSchema).max(1_000),
  suites: z.array(ProfileEvaluationSuiteSchema).max(100),
}).strict();

export type ProfileEvaluationCatalog = z.infer<typeof ProfileEvaluationCatalogSchema>;
export type ProfileEvaluationDefinition = z.infer<typeof ProfileEvaluationDefinitionSchema>;

/** Added to a Taskset run manifest only when a Profile component supplies the
 * candidate behavior. It does not change the Taskset's frozen cases/graders. */
export const ProfileEvaluationRunSourceSchema = z.object({
  profileId: ReleaseIdSchema,
  sourceRevision: z.string().trim().min(1).max(240),
  harnessRelease: ImmutableReleaseRefSchema,
  catalogHash: ReleaseHashSchema,
  definitionId: ReleaseIdSchema,
  definitionHash: ReleaseHashSchema,
  target: ProfileEvaluationTargetSchema,
  environmentHash: ReleaseHashSchema,
}).strict();
export type ProfileEvaluationRunSource = z.infer<typeof ProfileEvaluationRunSourceSchema>;

/** Validate component and suite references against the same Profile release. */
export function validateProfileEvaluationCatalog(input: {
  catalog: unknown;
  workflowIds: ReadonlySet<string>;
  skillPaths: ReadonlySet<string>;
  actionIds: ReadonlySet<string>;
}): { catalog: ProfileEvaluationCatalog; contentHash: string } {
  const catalog = ProfileEvaluationCatalogSchema.parse(input.catalog);
  const ids = new Set<string>();
  for (const definition of catalog.definitions) {
    if (ids.has(definition.id)) throw new Error(`Duplicate Profile evaluation ${definition.id}.`);
    ids.add(definition.id);
    switch (definition.target.kind) {
      case "workflow":
        if (!input.workflowIds.has(definition.target.workflowId)) throw new Error(`Profile evaluation ${definition.id} references a missing workflow.`);
        break;
      case "skill":
        if (!input.skillPaths.has(definition.target.skillPath)) throw new Error(`Profile evaluation ${definition.id} references a missing Skill.`);
        break;
      case "agent_action":
        if (!input.actionIds.has(definition.target.actionId)) throw new Error(`Profile evaluation ${definition.id} references a missing Agent action.`);
        break;
    }
  }
  const suiteIds = new Set<string>();
  for (const suite of catalog.suites) {
    if (suiteIds.has(suite.id)) throw new Error(`Duplicate Profile evaluation suite ${suite.id}.`);
    suiteIds.add(suite.id);
    if (new Set(suite.definitionIds).size !== suite.definitionIds.length) throw new Error(`Profile evaluation suite ${suite.id} repeats a definition.`);
    for (const definitionId of suite.definitionIds) {
      if (!ids.has(definitionId)) throw new Error(`Profile evaluation suite ${suite.id} references missing definition ${definitionId}.`);
    }
    if (suite.scope === "profile" && suite.definitionIds.every((id) => catalog.definitions.find((definition) => definition.id === id)?.target.kind !== "profile")) {
      throw new Error(`Profile evaluation suite ${suite.id} needs an end-to-end Profile definition.`);
    }
  }
  return { catalog, contentHash: contentHash(catalog) };
}

export function resolveProfileEvaluationRunSource(input: {
  catalog: ProfileEvaluationCatalog;
  definitionId: string;
  profileId: string;
  sourceRevision: string;
  harnessRelease: { id: string; contentHash: string };
  environmentHash: string;
}): ProfileEvaluationRunSource {
  const catalog = ProfileEvaluationCatalogSchema.parse(input.catalog);
  const definition = catalog.definitions.find((candidate) => candidate.id === input.definitionId);
  if (!definition) throw new Error(`Profile evaluation ${input.definitionId} is absent from its catalog.`);
  return ProfileEvaluationRunSourceSchema.parse({
    profileId: input.profileId,
    sourceRevision: input.sourceRevision,
    harnessRelease: input.harnessRelease,
    catalogHash: contentHash(catalog),
    definitionId: definition.id,
    definitionHash: contentHash(definition),
    target: definition.target,
    environmentHash: input.environmentHash,
  });
}

/** Evaluation definitions are read from the verifier-only bytes of an exact
 * released source package. The caller must never forward this asset to the
 * model-visible policy surface. */
export function loadReleasedProfileEvaluationCatalog(value: unknown): {
  catalog: ProfileEvaluationCatalog;
  catalogHash: string;
  harnessRelease: { id: string; contentHash: string };
} {
  const source = validateHarnessSourcePackage(value);
  const files = harnessSourcePackageFiles(source);
  const result = loadReleasedProfileEvaluationCatalogAssets({
    agentSnapshot: source.agentSnapshot,
    harnessRelease: source.harnessRelease,
    catalogBytes: files.get("evals/catalog.json"),
    workflowBytes: files.get("workflows/catalog.json"),
    actionBytes: files.get("workflows/actions.json"),
  });
  return { ...result, harnessRelease: {
    id: source.harnessRelease.id, contentHash: source.harnessRelease.contentHash,
  } };
}

/** For a local release whose caller already verified its full file inventory. */
export function loadReleasedProfileEvaluationCatalogAssets(input: {
  agentSnapshot: AgentSnapshot;
  harnessRelease: HarnessRelease;
  catalogBytes?: Uint8Array;
  workflowBytes?: Uint8Array;
  actionBytes?: Uint8Array;
}): { catalog: ProfileEvaluationCatalog; catalogHash: string } {
  const asset = input.harnessRelease.files.find((file) => file.path === "evals/catalog.json");
  const bytes = input.catalogBytes;
  if (!asset || asset.visibility !== "verifier" || !bytes || sha256(bytes) !== asset.contentHash) {
    throw new Error("Released Profile evaluation catalog is unavailable or not verifier-private.");
  }
  const workflows = input.workflowBytes || input.actionBytes
    ? loadReleasedProfileWorkflowCatalogAssets({
        agentSnapshot: input.agentSnapshot,
        harnessRelease: input.harnessRelease,
        catalogBytes: input.workflowBytes,
        actionBytes: input.actionBytes,
      })
    : null;
  const { catalog, contentHash: catalogHash } = validateProfileEvaluationCatalog({
    catalog: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    workflowIds: new Set(workflows?.catalog.workflows.map((workflow) => workflow.id) ?? []),
    skillPaths: new Set(input.agentSnapshot.skills.map((skill) => skill.path)),
    actionIds: new Set(workflows?.actions.map((action) => action.id) ?? []),
  });
  return { catalog, catalogHash };
}
