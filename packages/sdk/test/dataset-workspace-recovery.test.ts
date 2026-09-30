import { describe, expect, it } from "vitest";
import { contentHash } from "@openpond/harness";
import { OpenPondDatasetWorkspaceClient } from "../src/dataset-workspace-client.js";
import { createTasksetDraft } from "../src/taskset-draft-authoring.js";
import { createTasksetDraftWorkspace } from "../src/taskset-draft-workspace.js";

describe("Dataset retained operation identity boundary", () => {
  // Recovery must never accept another actor's Dataset frame, a changed owner,
  // different operation, or lifecycle transition from a forged transport page.
  it("accepts a sealed original creation receipt and rejects substituted identities and transition frames", async () => {
    const draft = createTasksetDraft({ id: "dataset-a", profileId: "team-a", name: "Dataset", now: "2026-09-30T12:00:00.000Z" });
    const workspace = createTasksetDraftWorkspace({ schemaVersion: "openpond.tasksetDraftWorkspace.v1", draft, files: [] });
    const receipt = { schemaVersion: "openpond.datasetWorkspaceReceipt.v1", teamId: "team-a", datasetId: draft.id, revision: 1, workspace, publication: null };
    const original = { operationId: "op-a", kind: "create", requestHash: contentHash({ intent: "create" }), receipt, base: null };
    let response: unknown = original;
    const client = new OpenPondDatasetWorkspaceClient({ baseUrl: "https://example.test", apiKey: "test", teamId: "team-a", fetch: async () => Response.json(response) });
    await expect(client.operationResult("op-a", { datasetId: draft.id, kind: "create" })).resolves.toEqual(original);
    for (const value of [ { ...original, operationId: "op-b" }, { ...original, receipt: { ...receipt, teamId: "team-b" } }, { ...original, kind: "publish" }, { ...original, privateExpectedOutput: "forbidden" } ]) {
      response = value; await expect(client.operationResult("op-a", { datasetId: draft.id, kind: "create" })).rejects.toThrow();
    }
    response = original;
    await expect(client.operationResult("op-a", { datasetId: "another", kind: "create" })).rejects.toThrow();
    await expect(client.operationResult("op-a", { kind: "create", requestHash: "b".repeat(64) })).rejects.toThrow();
    response = null; await expect(client.operationResult("unknown", { kind: "create" })).resolves.toBeNull();
  });
});
