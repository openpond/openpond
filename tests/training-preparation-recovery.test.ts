import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { canonicalJson, canonicalSha256, TrainingExperimentSetupRequestSchema, trainingExperimentConfigurationIdentity } from "openpond-sdk/training";
import { reconcileChangedTrainingPreparation } from "../apps/web/src/components/labs/workspace/training-preparation-recovery";

// Failure story: editing after a lost preparation/cancellation reply overwrites
// the original operation, or a submitted Job is silently replaced. Exercise the
// retained HTTP protocol without starting compute or simulating host admission.
test("reconciles the original preparation across edited inputs and uncertain cancellation", async () => {
  const fixture = JSON.parse(await readFile(new URL("../packages/sdk/fixtures/training/v2/policy-optimize.valid.json", import.meta.url), "utf8"));
  const request = TrainingExperimentSetupRequestSchema.parse({ schemaVersion: "openpond.trainingExperimentSetupRequest.v1",
    teamId: "team-fixture", operationId: "retained-operation", projectId: null,
    baseModel: fixture.job.baseModel, settings: { method: "grpo", recipe: fixture.job.recipe },
    batch: { id: "batch", revision: 1, contentHash: "b".repeat(64) }, name: "Original inputs", maximumSpendUsd: 2 });
  const { schemaVersion: _schema, baseModel: _base, settings: _settings, ...run } = request;
  const source = { ...fixture.source, modelProject: { ...fixture.source.modelProject,
    portableProjectId: await trainingExperimentConfigurationIdentity(request, "owner") } };
  const preparedRequest = { ...run, schemaVersion: "openpond.trainingPreparationRequest.v1",
    configuration: { id: source.modelProject.id, expectedRevision: source.modelProject.revision, expectedEtag: source.modelProject.contentHash } };
  const content = { schemaVersion: "openpond.trainingPreparationPlan.v1", id: "original-preparation", creatorUserId: "owner",
    request: preparedRequest, requestHash: await canonicalSha256(preparedRequest), source,
    submissionHash: "c".repeat(64), createdAt: "2026-10-31T00:00:00.000Z" };
  const plan = { ...content, contentHash: await canonicalSha256(content) };
  let state: "prepared" | "cancelled" | "submitted" = "prepared", mode: "lost" | "valid" | "wrong-plan" = "lost";
  let acknowledgements = 0;
  const cancellations: unknown[] = [], requests: string[] = [];
  const receipt = () => ({ schemaVersion: "openpond.trainingPreparationReceipt.v1", plan,
    revision: state === "prepared" ? 1 : 2, state, jobId: state === "submitted" ? "existing-job" : null });
  const server = createServer(async (incoming, outgoing) => {
    const reply = (value: unknown) => { outgoing.writeHead(200, { "content-type": "application/json" }); outgoing.end(JSON.stringify(value)); };
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(incoming.url!);
      if (incoming.url === "/acknowledge") { acknowledgements++; reply({ ok: true }); return; }
      if (incoming.url === "/prepare-draft") {
        expect(canonicalJson(body)).toBe(canonicalJson(request));
        reply({ schemaVersion: "openpond.trainingExperimentSetupReceipt.v1", request,
          requestHash: await canonicalSha256(request), preparation: receipt() }); return;
      }
      expect(incoming.url).toBe("/cancel"); cancellations.push(body);
      expect(body).toEqual({ id: plan.id, control: { teamId: request.teamId, planHash: plan.contentHash, expectedRevision: 1 } });
      if (mode === "wrong-plan") {
        const other = { ...content, id: "different-preparation" };
        reply({ ...receipt(), state: "cancelled", revision: 2, plan: { ...other, contentHash: await canonicalSha256(other) } }); return;
      }
      state = "cancelled";
      if (mode === "lost") { incoming.socket.destroy(); return; }
      reply(receipt());
    } catch (error) { outgoing.writeHead(500); outgoing.end(JSON.stringify({ error: String(error) })); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected local HTTP listener.");
    const post = async (command: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/${command}`, { method: "POST", body: JSON.stringify(body) });
      if (!response.ok) throw new Error("Protocol peer rejected the request.");
      return response.json();
    };
    const retained = { request, snapshot: "original", acknowledge: async () => { await post("acknowledge", { operationId: request.operationId }); } };
    const recover = () => reconcileChangedTrainingPreparation({ retained, snapshot: "edited", request: post });
    await expect(recover()).rejects.toThrow();
    expect(acknowledgements).toBe(0);
    mode = "valid";
    expect(await recover()).toEqual({ kind: "cancelled" });
    expect(cancellations).toHaveLength(1); // The lost cancellation already committed.
    expect(acknowledgements).toBe(1);
    state = "submitted";
    expect(await recover()).toEqual({ kind: "submitted", jobId: "existing-job" });
    expect(cancellations).toHaveLength(1);
    state = "prepared"; mode = "wrong-plan";
    await expect(recover()).rejects.toThrow();
    expect(acknowledgements).toBe(2);
    expect(new Set(requests)).toEqual(new Set(["/prepare-draft", "/cancel", "/acknowledge"]));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
