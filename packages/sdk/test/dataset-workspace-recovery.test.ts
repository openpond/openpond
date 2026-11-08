import { describe, expect, it } from "vitest";
import { contentHash } from "@openpond/harness";
import { OpenPondDatasetWorkspaceClient } from "../src/dataset-workspace-client.js";
import { DatasetWorkspaceRequestError } from "../src/dataset-workspace-error.js";
import { createTasksetDraft } from "../src/taskset-draft-authoring.js";
import { createTasksetDraftWorkspace } from "../src/taskset-draft-workspace.js";

describe("Dataset retained operation identity boundary", () => {
  // Native/CLI recovery needs a rejected validation's identity without leaking
  // arbitrary server diagnostics, submitted content or an unbounded error body.
  it("retains safe failure status/code while discarding unsafe diagnostics and bounding the wire body", async () => {
    const sensitive = "synthetic-sensitive-diagnostic-do-not-display";
    const knownCodes = ["dataset_validation_failed", "dataset_grader_invalid", "dataset_grader_source_unavailable", "dataset_feedback_key_conflict"] as const;
    let response: Response;
    const client = new OpenPondDatasetWorkspaceClient({ baseUrl: "https://example.test", apiKey: "test", teamId: "team-a", fetch: async () => response });
    async function failure(status: number, code: string, retryable = false, outcomeUnknown = false) {
      const error = await client.validate("dataset-a", 1).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(DatasetWorkspaceRequestError);
      expect(error).toMatchObject({ status, code, retryable, outcomeUnknown });
      expect(`${JSON.stringify(error)} ${String(error)}`).not.toContain(sensitive);
      expect(error).not.toHaveProperty("cause");
      expect(error).not.toHaveProperty("body");
      expect(error).not.toHaveProperty("details");
    }
    for (const code of knownCodes) {
      response = Response.json({ code, message: sensitive }, { status: 422 });
      await failure(422, code);
    }
    for (const body of [
      { code: `${sensitive}_provider_error`, message: sensitive },
      { code: "dataset_validation_failed", details: { input: sensitive } },
      { code: "dataset_validation_failed", message: sensitive.repeat(150) },
      { code: ["dataset_validation_failed"], message: sensitive },
    ]) {
      response = Response.json(body, { status: 422 });
      await failure(422, "dataset_request_failed");
    }
    response = new Response(`<html>${sensitive}</html>`, { status: 503, headers: { "content-type": "text/html" } });
    await failure(503, "dataset_request_failed", true, true);
    response = new Response(`{"code":"dataset_validation_failed","message":"${sensitive}`, { status: 422, headers: { "content-type": "application/json" } });
    await failure(422, "dataset_request_failed");
    let canceled = false;
    response = new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new TextEncoder().encode(sensitive.repeat(500))); },
      cancel() { canceled = true; },
    }), { status: 422, headers: { "content-type": "application/json" } });
    await failure(422, "dataset_request_failed");
    expect(canceled).toBe(true);
    response = new Response(new ReadableStream({
      pull(controller) { controller.error(new Error(sensitive)); },
    }), { status: 503, headers: { "content-type": "application/json" } });
    await failure(503, "dataset_request_failed", true, true);
    response = Response.json({ code: "dataset_operation_conflict", message: sensitive }, { status: 409 });
    await failure(409, "dataset_operation_conflict");
    response = Response.json({ code: "dataset_request_failed" }, { status: 429 });
    await failure(429, "dataset_request_failed", true, false);
    response = Response.json({ code: "dataset_request_failed" }, { status: 408 });
    await failure(408, "dataset_request_failed", true, true);
  });
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
