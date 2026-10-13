import { z } from "zod";
import { ChatResourceSummarySchema, LocalExperimentRecordPageSchema, LocalDatasetRecordSchema } from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import { useQuery } from "@tanstack/react-query";
import type { Inventory, WorkspaceApi } from "./workspace-api";

export const LocalLearningCatalogSchema = z.array(z.object({
  summary: ChatResourceSummarySchema,
  projectId: z.string().nullable(),
  profileTarget: z.object({ profileId: z.string(), workflowId: z.string().nullable() }).strict().nullable(),
  updatedAt: z.string(), workspaceHash: z.string(), packageHash: z.string().nullable(),
  graders: z.array(z.object({
    id: z.string(), graderId: z.string(), name: z.string(), kind: z.string(), version: z.string(),
    configurationHash: z.string(), weight: z.number(), hardGate: z.boolean(), rewardEligible: z.boolean(),
    privileged: z.boolean(), checkState: z.string(), verifierPath: z.string().nullable(), fields: z.array(z.string()),
  }).strict()),
}).strict());
export const LocalDatasetMetadataSchema = z.object({ record: LocalDatasetRecordSchema.omit({ workspace: true }).extend({
  workspace: LocalDatasetRecordSchema.shape.workspace.omit({ files: true }),
}), summary: ChatResourceSummarySchema });

export function localMetadataGraders(record: z.infer<typeof LocalDatasetMetadataSchema>["record"]): LocalLearningDataset["graders"] {
  const draft = record.workspace.draft;
  const check = record.checks.find(check => check.kind === "graders" && check.workspaceHash === record.workspace.contentHash);
  return draft.graders.map(grader => {
    const scope = check?.scopes?.find(scope => scope.graderId === grader.id);
    const ref = grader.metadata.portableVerifierRef;
    return { id: `grader-${contentHash([draft.id,grader.id]).slice(0,40)}`, graderId: grader.id, name: grader.label, kind: grader.kind,
      version: grader.version, configurationHash: contentHash(grader), weight: grader.weight, hardGate: grader.hardGate,
      rewardEligible: grader.rewardEligible, privileged: grader.privileged,
      checkState: scope ? `${scope.checked}/${scope.total} ${scope.status}` : check ? check.status : "Not checked",
      verifierPath: ref && typeof ref === "object" && "path" in ref && typeof ref.path === "string" ? ref.path : null,
      fields: Array.isArray(draft.metadata.fields) ? draft.metadata.fields.filter((field): field is string => typeof field === "string") : [] };
  });
}

export type LocalLearningDataset = z.infer<typeof LocalLearningCatalogSchema>[number];

export function useLocalLearningCatalog(api: WorkspaceApi) {
  return useQuery({ queryKey: ["installation-learning-catalog", api.connection.serverUrl, api.accountKey, api.actorId],
    queryFn: async ({ signal }) => LocalLearningCatalogSchema.parse(await api.localDatasets("list", { view: "catalog" }, undefined, signal)),
  });
}


export function useProjectLocalProfiles(api: WorkspaceApi) {
  return useQuery({ queryKey: ["local-project-profile-associations", api.connection.serverUrl, api.accountKey, api.actorId, api.teamId, api.projectId],
    enabled: Boolean(api.projectId),
    queryFn: async ({ signal }) => {
      const profiles = new Set<string>();
      let afterId: string | undefined;
      do {
        const page = LocalExperimentRecordPageSchema.parse(await api.local("list", { projectId: api.projectId, limit: 100, ...(afterId ? { afterId } : {}) }, signal));
        for (const row of page.items) if (row.configuration.request.policy.kind === "hosted_harness") profiles.add(row.configuration.request.policy.source.profileId);
        if (page.nextCursor === afterId) throw new Error("Local Project association paging did not advance.");
        afterId = page.nextCursor ?? undefined;
      } while (afterId);
      return [...profiles];
    },
  });
}

export function localDatasetsForProject(rows: LocalLearningDataset[], api: WorkspaceApi, inventory?: Inventory | null, retainedProfiles: string[] = []) {
  if (!api.projectId) return rows;
  const project = inventory?.projects.projects.find(project => project.id === api.projectId);
  const profiles = new Set([...retainedProfiles, ...(project?.content.targets.flatMap(entry => entry.target.kind === "harness" ? [entry.target.source.profileId] : []) ?? [])]);
  return rows.filter(row => row.projectId === api.projectId || row.profileTarget && profiles.has(row.profileTarget.profileId));
}

export function profileDisplayName(id: string | null | undefined) {
  return id ? id.split("-").map(word => word ? word[0]!.toUpperCase() + word.slice(1) : word).join(" ") : "—";
}
