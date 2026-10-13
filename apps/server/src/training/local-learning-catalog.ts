import { contentHash } from "@openpond/harness";
import type { ChatResourceSummary } from "@openpond/contracts";
import type { LocalDatasetListing } from "../store/store-chat-resources.js";

/** Installation-owned catalog metadata. Never return tasks, files, fixture
 * outputs, source labels, or private grader implementation/configuration. */
export function localLearningCatalog(records: LocalDatasetListing[], summary: (record: LocalDatasetListing) => ChatResourceSummary) {
  return records.map(record => {
    const draft = record.workspace.draft;
    const rawTarget = draft.metadata.profileTarget;
    const target = rawTarget && typeof rawTarget === "object" && !Array.isArray(rawTarget) ? rawTarget as Record<string, unknown> : {};
    const profileTarget = typeof target.profileId === "string" ? {
      profileId: target.profileId,
      workflowId: typeof target.workflowId === "string" ? target.workflowId : null,
    } : null;
    const check = record.checks.find(check => check.kind === "graders" && check.workspaceHash === record.workspace.contentHash);
    return {
      summary: { ...summary(record), rows: [] },
      projectId: record.projectId,
      profileTarget,
      updatedAt: draft.updatedAt,
      workspaceHash: record.workspace.contentHash,
      packageHash: record.packageHash,
      graders: draft.graders.map(grader => {
        const scope = check?.scopes?.find(scope => scope.graderId === grader.id);
        const ref = grader.metadata.portableVerifierRef;
        return {
          id: `grader-${contentHash([draft.id, grader.id]).slice(0, 40)}`,
          graderId: grader.id,
          name: grader.label,
          kind: grader.kind,
          version: grader.version,
          configurationHash: contentHash(grader),
          weight: grader.weight,
          hardGate: grader.hardGate,
          rewardEligible: grader.rewardEligible,
          privileged: grader.privileged,
          checkState: scope ? `${scope.checked}/${scope.total} ${scope.status}` : check ? check.status : "Not checked",
          verifierPath: ref && typeof ref === "object" && "path" in ref && typeof ref.path === "string" ? ref.path : null,
          fields: Array.isArray(draft.metadata.fields) ? draft.metadata.fields.filter((field): field is string => typeof field === "string") : [],
        };
      }),
    };
  });
}
