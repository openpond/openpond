import { describe, expect, it } from "vitest";
import { contentHash } from "@openpond/harness";
import { createTasksetDraft, createTasksetDraftWorkspace, saveTasksetDraftWorkspaceDocument } from "openpond-sdk/taskset-drafts";
import type { DatasetWorkspaceReceipt, OpenPondDatasetWorkspaceClient } from "openpond-sdk/dataset-workspaces";
import { hostedDatasetAuthoring } from "./hosted-dataset-authoring.js";

describe("hosted Dataset lost-response recovery", () => {
  // A write committed before transport loss must recover its own old receipt
  // after another edit, without repeating the CAS write or changing its intent.
  it("recovers the original saved bytes after later edits and rejects operation reuse with changed form data", async () => {
    const now = "2026-09-30T12:00:00.000Z", draft = createTasksetDraft({ id: "dataset-a", profileId: "team-a", name: "Initial", now });
    const base: DatasetWorkspaceReceipt = { schemaVersion: "openpond.datasetWorkspaceReceipt.v1", teamId: "team-a", datasetId: draft.id, revision: 1, workspace: createTasksetDraftWorkspace({ schemaVersion: "openpond.tasksetDraftWorkspace.v1", draft, files: [] }), publication: null };
    const changed = { ...draft, name: "Original edit", updatedAt: now };
    const workspace = saveTasksetDraftWorkspaceDocument({ workspace: base.workspace, expectedDraftRevision: 1, draft: changed, now });
    const write = { expectedRevision: 1, operationId: "op-a", workspace };
    const receipt = { ...base, revision: 2, workspace };
    const newerWorkspace = saveTasksetDraftWorkspaceDocument({ workspace, expectedDraftRevision: 2, draft: { ...workspace.draft, name: "Later edit" }, now });
    const newer = { ...base, revision: 3, workspace: newerWorkspace };
    let writes = 0;
    const client = { operationResult: async () => ({ operationId: "op-a", kind: "save", requestHash: contentHash(write), receipt, base }), save: async () => { writes++; throw new Error("Recovered writes must not dispatch again."); } } as unknown as OpenPondDatasetWorkspaceClient;
    const invoke = (form: typeof changed) => hostedDatasetAuthoring({ client, teamId: "team-a", projectId: null, operation: "saveDraft", value: { id: draft.id, operationId: "op-a", now, draft: form }, requireDataset: async () => newer });
    await expect(invoke(changed)).resolves.toEqual(receipt);
    await expect(invoke({ ...changed, name: "Substituted edit" })).rejects.toThrow("another Dataset change");
    expect(writes).toBe(0); expect(newer.workspace.draft.name).toBe("Later edit");
  });
});
