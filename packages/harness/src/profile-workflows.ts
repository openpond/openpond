import { z } from "zod";

import { contentHash, ImmutableReleaseRefSchema, ReleaseHashSchema, sha256 } from "./common.js";
import { harnessSourcePackageFiles, validateHarnessSourcePackage, type HarnessSourcePackage } from "./source-package.js";
import type { AgentSnapshot, HarnessRelease } from "./harness.js";

const WorkflowIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,119}$/);
const SourcePathSchema = z.string().min(1).max(2_000).refine((value) =>
  !value.includes("\\") && !value.includes(":") && !value.startsWith("/")
  && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  "workflow references require portable relative paths",
);

export const ProfileWorkflowSchema = z.object({
  id: WorkflowIdSchema,
  label: z.string().trim().min(1).max(240),
  description: z.string().max(4_000),
  inputSchema: z.record(z.string(), z.unknown()),
  invocation: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("instructions"), instructions: z.string().trim().min(1).max(100_000) }).strict(),
    z.object({ kind: z.literal("agent_action"), actionId: z.string().trim().min(1).max(240) }).strict(),
  ]),
  skillPaths: z.array(SourcePathSchema).max(100),
}).strict();

export const ProfileWorkflowCatalogSchema = z.object({
  schemaVersion: z.literal("openpond.profileWorkflows.v1"),
  workflows: z.array(ProfileWorkflowSchema).max(1_000),
}).strict();

export type ProfileWorkflow = z.infer<typeof ProfileWorkflowSchema>;
export type ProfileWorkflowCatalog = z.infer<typeof ProfileWorkflowCatalogSchema>;

/** Action identities retained beside a released workflow catalog. The host
 * resolves these identities to the Agent files in the same immutable release. */
export const ProfileWorkflowActionSchema = z.object({
  id: z.string().trim().min(1).max(240),
  agentId: z.string().regex(/^[a-zA-Z0-9_-]{1,240}$/),
  sourceActionId: z.string().trim().min(1).max(240),
  inputSchema: z.record(z.string(), z.unknown()),
}).strict();

export const ProfileWorkflowActionsSchema = z.object({
  schemaVersion: z.literal("openpond.profileWorkflowActions.v1"),
  actions: z.array(ProfileWorkflowActionSchema).max(200),
}).strict();

export type ProfileWorkflowAction = z.infer<typeof ProfileWorkflowActionSchema>;

/** Validates references against the exact files admitted to a released source. */
export function validateProfileWorkflowCatalog(input: {
  catalog: unknown;
  sourcePaths: ReadonlySet<string>;
  actionIds: ReadonlySet<string>;
}): ProfileWorkflowCatalog {
  const catalog = ProfileWorkflowCatalogSchema.parse(input.catalog);
  const ids = new Set<string>();
  for (const workflow of catalog.workflows) {
    if (ids.has(workflow.id)) throw new Error(`Duplicate Profile workflow id ${workflow.id}.`);
    ids.add(workflow.id);
    for (const skillPath of workflow.skillPaths) {
      if (!input.sourcePaths.has(skillPath)) throw new Error(`Profile workflow ${workflow.id} references missing Skill ${skillPath}.`);
    }
    if (workflow.invocation.kind === "agent_action" && !input.actionIds.has(workflow.invocation.actionId)) {
      throw new Error(`Profile workflow ${workflow.id} references missing action ${workflow.invocation.actionId}.`);
    }
  }
  return catalog;
}

export const ProfileWorkflowBindingSchema = z.object({
  schemaVersion: z.literal("openpond.profileWorkflowBinding.v1"),
  profileId: z.string().trim().min(1).max(240),
  sourceRevision: z.string().trim().min(1).max(240),
  harnessRelease: ImmutableReleaseRefSchema,
  catalogHash: ReleaseHashSchema,
  workflowId: WorkflowIdSchema,
}).strict();

export type ProfileWorkflowBinding = z.infer<typeof ProfileWorkflowBindingSchema>;

/** Resolve a catalog only from a verified immutable source package. */
export function loadReleasedProfileWorkflowCatalog(value: unknown): {
  sourcePackage: HarnessSourcePackage;
  catalog: ProfileWorkflowCatalog;
  catalogHash: string;
  actions: ProfileWorkflowAction[];
} {
  const sourcePackage = validateHarnessSourcePackage(value);
  const files = harnessSourcePackageFiles(sourcePackage);
  const loaded = loadReleasedProfileWorkflowCatalogAssets({
    agentSnapshot: sourcePackage.agentSnapshot,
    harnessRelease: sourcePackage.harnessRelease,
    catalogBytes: files.get("workflows/catalog.json"),
    actionBytes: files.get("workflows/actions.json"),
  });
  return { sourcePackage, ...loaded };
}

/** Load only the two workflow assets after the caller has verified all files
 * in a local release. This avoids packaging large Agent source each turn. */
export function loadReleasedProfileWorkflowCatalogAssets(input: {
  agentSnapshot: AgentSnapshot;
  harnessRelease: HarnessRelease;
  catalogBytes?: Uint8Array;
  actionBytes?: Uint8Array;
}): { catalog: ProfileWorkflowCatalog; catalogHash: string; actions: ProfileWorkflowAction[] } {
  const asset = input.harnessRelease.files.find((file) => file.path === "workflows/catalog.json");
  const actionAsset = input.harnessRelease.files.find((file) => file.path === "workflows/actions.json");
  if (!asset || asset.visibility !== "policy" || !input.catalogBytes || sha256(input.catalogBytes) !== asset.contentHash) {
    throw new Error("Released Profile workflow catalog is unavailable or invalid.");
  }
  if (!actionAsset || actionAsset.visibility !== "policy" || !input.actionBytes || sha256(input.actionBytes) !== actionAsset.contentHash) {
    throw new Error("Released Profile workflow actions are unavailable or invalid.");
  }
  const actions = ProfileWorkflowActionsSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.actionBytes))).actions;
  const actionIds = new Set<string>();
  for (const action of actions) {
    if (actionIds.has(action.id)) throw new Error(`Duplicate released Profile action ${action.id}.`);
    actionIds.add(action.id);
    if (!input.harnessRelease.files.some((file) => file.path.startsWith(`agents/${action.agentId}/`))) {
      throw new Error(`Released Profile action ${action.id} lacks its Agent source.`);
    }
  }
  const catalog = validateProfileWorkflowCatalog({
    catalog: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.catalogBytes)),
    sourcePaths: new Set(input.agentSnapshot.skills.map((skill) => skill.path)),
    actionIds,
  });
  return { catalog, catalogHash: contentHash(catalog), actions };
}

export function resolveReleasedProfileWorkflowCatalogBinding(input: {
  binding: unknown;
  harnessRelease: HarnessRelease;
  catalog: ProfileWorkflowCatalog;
  catalogHash: string;
}): ProfileWorkflow {
  const binding = ProfileWorkflowBindingSchema.parse(input.binding);
  if (binding.harnessRelease.id !== input.harnessRelease.id
    || binding.harnessRelease.contentHash !== input.harnessRelease.contentHash) {
    throw new Error("Profile workflow binding differs from the released source package.");
  }
  if (binding.catalogHash !== input.catalogHash) throw new Error("Profile workflow catalog differs from its binding.");
  const profile = input.harnessRelease.metadata.profile;
  if (!profile || typeof profile !== "object") throw new Error("Released source lacks Profile provenance.");
  const provenance = profile as Record<string, unknown>;
  if (provenance.id !== binding.profileId || provenance.sourceRevision !== binding.sourceRevision) {
    throw new Error("Profile workflow binding differs from released Profile provenance.");
  }
  const workflow = input.catalog.workflows.find((candidate) => candidate.id === binding.workflowId);
  if (!workflow) throw new Error(`Profile workflow ${binding.workflowId} is absent from its bound catalog.`);
  return workflow;
}

export function resolveReleasedProfileWorkflow(input: {
  binding: unknown;
  sourcePackage: unknown;
}): ProfileWorkflow {
  const binding = ProfileWorkflowBindingSchema.parse(input.binding);
  const { sourcePackage, catalog, catalogHash } = loadReleasedProfileWorkflowCatalog(input.sourcePackage);
  return resolveReleasedProfileWorkflowCatalogBinding({ binding, harnessRelease: sourcePackage.harnessRelease, catalog, catalogHash });
}

export function resolveProfileWorkflowBinding(input: {
  binding: unknown;
  catalog: unknown;
  sourcePaths: ReadonlySet<string>;
  actionIds: ReadonlySet<string>;
  harnessRelease: { id: string; contentHash: string };
}): ProfileWorkflow {
  const binding = ProfileWorkflowBindingSchema.parse(input.binding);
  if (binding.harnessRelease.id !== input.harnessRelease.id
    || binding.harnessRelease.contentHash !== input.harnessRelease.contentHash) {
    throw new Error("Profile workflow binding differs from the admitted Harness release.");
  }
  const catalog = validateProfileWorkflowCatalog(input);
  if (contentHash(catalog) !== binding.catalogHash) throw new Error("Profile workflow catalog differs from its binding.");
  const workflow = catalog.workflows.find((candidate) => candidate.id === binding.workflowId);
  if (!workflow) throw new Error(`Profile workflow ${binding.workflowId} is absent from its bound catalog.`);
  return workflow;
}
