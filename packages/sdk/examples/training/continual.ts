import { readFile, writeFile } from "node:fs/promises";
import { LearningCommandSchema, LearningIterationSchema, LearningRevisionRefSchema, OpenPondLearningClient } from "openpond-sdk/learning";
import { createTrainingClient } from "openpond-sdk/training";

// Each invocation performs one explicit transition or one finite read snapshot.
const [action, inputPath, outputPath] = process.argv.slice(2);
if (!["inspect", "command", "reserve", "reconcile", "status", "results", "cancel", "retry"].includes(action ?? "") || !inputPath || !outputPath) throw new Error("Usage: continual.ts <inspect|command|reserve|reconcile|status|results|cancel|retry> <input.json> <new-response.json>");
const { OPENPOND_API_URL: baseUrl, OPENPOND_API_KEY: apiKey, OPENPOND_TEAM_ID: scope } = process.env;
if (!baseUrl || !apiKey || !scope) throw new Error("Set OPENPOND_API_URL, OPENPOND_API_KEY and OPENPOND_TEAM_ID.");
const bytes = await readFile(inputPath);
if (bytes.byteLength > 16_777_216) throw new Error("Learning input exceeds the protocol limit.");
const input: unknown = JSON.parse(bytes.toString("utf8"));
const client = new OpenPondLearningClient({ baseUrl, apiKey, scope });
const signal = AbortSignal.timeout(120_000);
const options = { signal };
const training = createTrainingClient({ baseUrl, headers: { Authorization: `Bearer ${apiKey}`, "X-OpenPond-Team-Id": scope }, fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal, redirect: "error" }) });
let result: unknown;
if (action === "inspect") result = await client.inspectPolicy(LearningRevisionRefSchema.parse(input), options);
else if (action === "reconcile") {
  const command = LearningCommandSchema.parse(input);
  if (command.action !== "reserve_iteration" || command.trigger.kind !== "manual") throw new Error("Reconcile the original manual reservation command.");
  const triggerIdentity = command.trigger.identity;
  const inspection = await client.inspectPolicy(command.policy, options);
  if (!inspection.chain) throw new Error("No chain observed; do not create another reservation automatically.");
  let afterId: string | undefined;
  let resultFound = false;
  const seen = new Set<string>();
  for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
    const page = await client.list("reservation", { parentId: inspection.chain.id, limit: 100, ...(afterId ? { afterId } : {}) }, options);
    const reservation = page.items.find((item) => item.policy.id === command.policy.id && item.policy.revision === command.policy.revision && item.policy.contentHash === command.policy.contentHash && item.trigger.kind === "manual" && item.trigger.identity === triggerIdentity);
    if (reservation) {
      const iteration = await client.get("iteration", reservation.iterationId, undefined, options);
      result = { reservation, iteration }; resultFound = true; break;
    }
    if (!page.nextCursor) break;
    if (seen.has(page.nextCursor)) throw new Error("Repeated reservation cursor.");
    seen.add(page.nextCursor); afterId = page.nextCursor;
  }
  if (!resultFound) throw new Error("Reservation not observed within finite scan; preserve original command and reconcile with operator before any replay.");
} else if (action === "command" || action === "reserve") {
  const command = LearningCommandSchema.parse(input);
  if ((action === "reserve") !== (command.action === "reserve_iteration")) throw new Error("Use explicit reserve for reserve_iteration; command is only for reviewed resource/evidence transitions.");
  if (command.action === "reserve_iteration" && command.trigger.kind !== "manual") throw new Error("This example declares manual-trigger continual iterations only.");
  // Reservation may be dispatched automatically by the host and incur compute.
  // The original policy/trigger/operationId is the lost-reply reconciliation key.
  const operation = await client.command(command, options);
  const iteration = operation.resources.find((resource) => resource.schemaVersion === "openpond.learningIteration.v1");
  result = { operation, ...(iteration ? { iteration } : {}) };
} else {
  if (!input || typeof input !== "object" || !("iteration" in input)) throw new Error("Use a retained response containing iteration; never invent a replacement reservation.");
  const retained = LearningIterationSchema.parse(input.iteration);
  let iteration = await client.get("iteration", retained.id, undefined, options);
  if (iteration.id !== retained.id || (iteration.policy.id !== retained.policy.id || iteration.policy.revision !== retained.policy.revision || iteration.policy.contentHash !== retained.policy.contentHash) || iteration.dispatchId !== retained.dispatchId) throw new Error("Iteration binding changed.");
  if (action === "cancel" || action === "retry") {
    if (!("operationId" in input) || typeof input.operationId !== "string") throw new Error("Add a new stable control operationId to the retained response before dispatch.");
    if (action === "retry") {
      const dispatch = await client.get("dispatch", iteration.dispatchId, undefined, options);
      if (dispatch.iterationId !== iteration.id || dispatch.state !== "blocked") throw new Error("Only the same blocked dispatch can be retried.");
    }
    const command = LearningCommandSchema.parse({ action: action === "cancel" ? "cancel_iteration" : "retry_iteration_dispatch", operationId: input.operationId, iterationId: iteration.id, expectedRevision: iteration.revision });
    const operation = await client.command(command, options);
    result = { operation, iteration: operation.resources.find((resource) => resource.schemaVersion === "openpond.learningIteration.v1") ?? iteration };
  } else {
    // Empty list is legitimate before the worker creates this dispatch.
    const page = await client.list("dispatch", { parentId: iteration.id, limit: 2 }, options);
    if (page.nextCursor || page.items.length > 1 || page.items.some((item) => item.id !== iteration.dispatchId)) throw new Error("Ambiguous dispatch identity.");
    const dispatch = page.items[0] ?? null;
    // Separate HTTP reads can straddle the worker's atomic commit. Refresh once.
    iteration = await client.get("iteration", retained.id, undefined, options);
    if (iteration.policy.id !== retained.policy.id || iteration.policy.revision !== retained.policy.revision || iteration.policy.contentHash !== retained.policy.contentHash || iteration.dispatchId !== retained.dispatchId) throw new Error("Iteration binding changed.");
    if (dispatch && (dispatch.iterationId !== iteration.id || dispatch.policy.id !== iteration.policy.id || dispatch.policy.revision !== iteration.policy.revision || dispatch.policy.contentHash !== iteration.policy.contentHash || dispatch.execution?.id !== iteration.trainingJob?.id || dispatch.execution?.contentHash !== iteration.trainingJob?.contentHash)) throw new Error("Snapshot changed; read status again without mutation.");
    if (!dispatch && iteration.trainingJob) throw new Error("Snapshot changed; read status again.");
    const job = iteration.trainingJob ? await training.getJob(iteration.trainingJob.id) : null;
    if (job && (job.id !== iteration.trainingJob?.id || job.submissionHash !== iteration.trainingJob?.contentHash)) throw new Error("Training execution content identity mismatch.");
    if (action === "results" && (!dispatch || dispatch.state !== "settled" || !dispatch.terminalReceipt)) throw new Error("No settled authoritative execution/cleanup receipt yet; retain status and inspect again.");
    if (action === "results" && !job && (iteration.status !== "cancelled" || dispatch?.execution)) throw new Error("Terminal job not observed.");
    result = { iteration, dispatch, job, ...(action === "results" && job ? { outputs: await training.outputs(job.id) } : {}) };
  }
}
await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log("Saved one retained transition/snapshot. Timeout does not cancel remote work; reconcile the same iteration before any explicit retry.");
