import { readFile, writeFile } from "node:fs/promises";
import { createTrainingClient, TrainingPreparationRequestSchema, TrainingPreparationReceiptSchema } from "openpond-sdk/training";

// The reviewed request points to existing immutable batch/configuration releases.
// No training occurs unless the caller explicitly selects `start`.
const [action, inputPath, outputPath] = process.argv.slice(2);
if (!["prepare", "start", "status", "results", "cancel"].includes(action ?? "") || !inputPath || !outputPath) {
  throw new Error("Usage: manual.ts <prepare|start|status|results|cancel> <request-or-receipt.json> <new-receipt.json>");
}
const baseUrl = process.env.OPENPOND_API_URL;
const apiKey = process.env.OPENPOND_API_KEY;
const teamId = process.env.OPENPOND_TEAM_ID;
if (!baseUrl || !apiKey || !teamId) throw new Error("Set OPENPOND_API_URL, OPENPOND_API_KEY and OPENPOND_TEAM_ID.");
const bytes = await readFile(inputPath);
if (bytes.byteLength > 1_048_576) throw new Error("Input exceeds the preparation limit.");
const input: unknown = JSON.parse(bytes.toString("utf8"));
const signal = AbortSignal.timeout(120_000);
const training = createTrainingClient({
  baseUrl,
  headers: { Authorization: `Bearer ${apiKey}`, "X-OpenPond-Team-Id": teamId },
  fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal, redirect: "error" }),
});
let result: unknown;
if (action === "prepare") {
  const request = TrainingPreparationRequestSchema.parse(input);
  if (request.teamId !== teamId) throw new Error("Request belongs to another workspace.");
  const capabilities = await training.capabilities();
  if (!capabilities.methods.includes("grpo")) throw new Error("This host does not advertise GRPO.");
  result = await training.prepareRun(request);
} else {
  // Reload and verify from the host instead of trusting a stale local revision.
  const retained = TrainingPreparationReceiptSchema.parse(input);
  const receipt = await training.getPreparation(teamId, retained.plan.id);
  if (receipt.plan.contentHash !== retained.plan.contentHash) throw new Error("Preparation identity changed.");
  if (action === "start") {
    if (receipt.state !== "prepared") throw new Error("Reconcile the retained job before starting again.");
    const catalog = await training.gpuCatalog();
    if (Date.parse(catalog.expiresAt) <= Date.now()) throw new Error("GPU catalog expired; refresh before requesting admission.");
    // Current hosts do not implement the SDK estimate endpoint. Retain the
    // current catalog for review; server admission still owns live price,
    // capacity, funding and the original request's immutable maximum spend.
    await writeFile(`${outputPath}.catalog.json`, JSON.stringify(catalog, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    result = await training.startPreparation(receipt.plan.id, { teamId, planHash: receipt.plan.contentHash,
      expectedRevision: receipt.revision });
  } else if (action === "status") {
    result = { preparation: receipt, job: receipt.jobId ? await training.getJob(receipt.jobId) : null };
  } else if (action === "results") {
    if (!receipt.jobId) throw new Error("The preparation has no submitted job.");
    result = await training.outputs(receipt.jobId);
  } else if (receipt.jobId) {
    const job = await training.getJob(receipt.jobId);
    result = await training.cancelJob(job.id, job.version);
  } else {
    result = await training.cancelPreparation(receipt.plan.id, { teamId, planHash: receipt.plan.contentHash, expectedRevision: receipt.revision });
  }
}
await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log("Saved the retained response. A request timeout does not cancel remote compute; reconcile the same preparation before any replay.");
