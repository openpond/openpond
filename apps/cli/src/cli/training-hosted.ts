import { attachHostedTrainingToChat } from "./training-chat-attachment";
import { readFile } from "node:fs/promises";
import { loadOpenPondAccountContext } from "@openpond/runtime";
import { createTrainingClient, parseAndVerifyTrainingJobSubmission, parseAndVerifyTrainingPreparationReceipt, TrainingPreparationRequestSchema, type TrainingInputArtifactUpload } from "openpond-sdk/training";
import { createModelProjectsClient, HostedModelProjectSyncSchema } from "openpond-sdk/model-projects";
import { OpenPondLearningClient } from "openpond-sdk/learning";
import { optionString, parseBooleanOption } from "./common/options";
import { resolveApiBaseUrlOption } from "./common/urls";
import { cancelHostedTrainingJob, parseHostedWatchOptions, watchHostedTrainingJob } from "./training-hosted-lifecycle";

type Options = Record<string, string | boolean>;
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

/** Hosted operations use the public SDK and account credential store directly.
 * They never start or depend on the local app server. App-scoped chat invocations
 * additionally attempt a recoverable attachment after successful operations. */
export async function runHostedTrainingCommand(options: Options, rest: string[]): Promise<void> {
  const action = rest[0], target = rest[1];
  const watchOptions = action === "hosted-watch" ? parseHostedWatchOptions(options) : null;
  const requestBound = { deadlineAt: watchOptions?.deadlineAt ?? null };
  const context = await accountContext(options);
  if (!context.token) throw new Error("Sign in to an OpenPond account before using hosted training.");
  const baseUrl = resolveApiBaseUrlOption(options) ?? context.apiBaseUrl;
  if (new URL(baseUrl).origin !== new URL(context.apiBaseUrl).origin)
    throw new Error("The hosted API URL must match the signed-in account’s API origin.");
  const teamId = optionString(options, "teamId");
  if (!teamId) throw new Error("Hosted training requires --team-id <workspace-id>.");
  const headers = new Headers({ "x-openpond-team-id": teamId });
  if (context.token.startsWith("opk_")) {
    headers.set("Authorization", `ApiKey ${context.token}`);
    headers.set("openpond-api-key", context.token);
  } else headers.set("Authorization", `Bearer ${context.token}`);
  const request: typeof fetch = (url, init) => {
    const remaining = requestBound.deadlineAt === null ? Infinity : requestBound.deadlineAt - Date.now();
    if (remaining <= 0) throw new DOMException("Hosted watch deadline reached", "TimeoutError");
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(watchOptions ? 10_000 : 180_000, remaining)));
    return fetch(url, {
      ...init, redirect: "error", signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
  };
  const client = createTrainingClient({ baseUrl, headers, fetch: request });
  const attach = (jobId:string)=>attachHostedTrainingToChat({jobId,teamId,apiOrigin:new URL(baseUrl).origin});
  const printAttached = async (value:unknown,jobId:string) => { print(value); await attach(jobId); };
  const readInput = async () => {
    if (!target) throw new Error(`${action} requires an input JSON file.`);
    const bytes = await readFile(target);
    if (bytes.byteLength > 64 * 1024 * 1024) throw new Error("Hosted training input exceeds 64 MiB.");
    return JSON.parse(bytes.toString("utf8"));
  };
  if (rest.length > 2) throw new Error(`${action} accepts at most one identifier or input file.`);
  if (["hosted-serving-pools", "hosted-base-serving-prepare", "hosted-serving-pool-retire"].includes(action ?? "")) {
    print(await (await import("./training-hosted-serving")).runHostedServingCommand({
      action: action!, target, baseUrl, headers, request, readInput,
      confirmed: parseBooleanOption(options.yes),
    })); return;
  }
  if (action === "hosted-provider" || action === "hosted-quotes") {
    if (target) throw new Error(`${action} does not accept an identifier.`);
    const path = action === "hosted-provider" ? "/v1/managed-rl/provider-inventory" : "/v1/managed-rl/quotes";
    const response = await request(new URL(path, baseUrl), { headers });
    const value: unknown = await response.json();
    if (!response.ok) throw new Error(`Hosted capacity read failed (${response.status}).`);
    print(value); return;
  }
  if (action === "hosted-workers" || action === "hosted-worker" || action?.startsWith("hosted-worker-")) {
    print(await (await import("./training-hosted-workers")).runHostedWorkerCommand({
      action, target, baseUrl, headers, request, readInput,
      confirmed: parseBooleanOption(options.yes),
    })); return;
  }
  if (action === "hosted-models") {
    print(await createModelProjectsClient({ baseUrl, headers, fetch: request }).list()); return;
  }
  if (action === "hosted-model") {
    if (!target) throw new Error("hosted-model requires a Model Project ID.");
    print(await createModelProjectsClient({ baseUrl, headers, fetch: request }).get(target)); return;
  }
  if (action === "hosted-sync-model") {
    const input = HostedModelProjectSyncSchema.parse(await readInput());
    print(await createModelProjectsClient({ baseUrl, headers, fetch: request }).upsert(input)); return;
  }
  if (action === "hosted-capabilities") { print(await client.capabilities()); return; }
  if (action === "hosted-batches") {
    const learning = new OpenPondLearningClient({ baseUrl, apiKey: context.token, scope: teamId, fetch: request });
    print(await learning.list("batch", { limit: 100 })); return;
  }
  if (action === "hosted-preparations") { print(await client.listPreparations(teamId)); return; }
  if (action === "hosted-jobs") { print(await client.listJobs({ limit: 100 })); return; }
  if (action === "hosted-prepare") {
    const input = TrainingPreparationRequestSchema.parse(await readInput());
    if (input.teamId !== teamId) throw new Error("Preparation input belongs to a different workspace.");
    print(await client.prepareRun(input)); return;
  }
  if (action === "hosted-start") {
    const receipt = await parseAndVerifyTrainingPreparationReceipt(await readInput());
    if (receipt.plan.request.teamId !== teamId) throw new Error("Preparation belongs to a different workspace.");
    if (!parseBooleanOption(options.yes)) throw new Error("Starting paid hosted training requires --yes.");
    const submitted = await client.startPreparation(receipt.plan.id, { teamId, planHash: receipt.plan.contentHash, expectedRevision: receipt.revision });
    print(submitted);
    if (submitted.jobId) await attach(submitted.jobId);
    return;
  }
  if (action === "hosted-stage") {
    print(await client.stageArtifact(await readInput() as TrainingInputArtifactUpload)); return;
  }
  if (action === "hosted-submit" || action === "hosted-qualify") {
    const input = await parseAndVerifyTrainingJobSubmission(await readInput());
    if (action === "hosted-qualify" && (input.job.kind !== "policy_optimize" || input.job.executionMode !== "qualification")) {
      throw new Error("hosted-qualify requires an immutable policy_optimize submission with executionMode=qualification.");
    }
    if (!parseBooleanOption(options.yes)) throw new Error("Submitting paid hosted training requires --yes.");
    if (input.job.kind === "policy_optimize" && input.job.executionMode === "qualification") {
      const capabilities = await client.capabilities();
      if (!capabilities.executionModes?.includes("qualification")) {
        throw new Error("This hosted runtime does not advertise original-learner qualification support.");
      }
    }
    const job = await client.createJob(input);
    if (job.teamId !== teamId || job.submissionHash !== input.contentHash || job.kind !== input.job.kind ||
      input.job.kind === "policy_optimize" && job.executionMode !== input.job.executionMode) {
      throw new Error(`Hosted submission response identity or execution mode mismatch; inspect hosted-status ${job.id} before attempting another submission.`);
    }
    await printAttached(job,job.id); return;
  }
  if (!target) throw new Error(`${action} requires a hosted job ID.`);
  if (action === "hosted-status") { await printAttached(await client.getJob(target),target); return; }
  if (action === "hosted-report") {
    const before = await client.getJob(target);
    const [events, outputs] = await Promise.all([client.events(target), client.outputs(target)]);
    const job = await client.getJob(target);
    if (job.id !== target || job.teamId !== teamId || before.id !== target || before.teamId !== teamId) {
      throw new Error("Hosted report status identity mismatch.");
    }
    const { buildHostedTrainingReport } = await import("./training-hosted-report");
    await printAttached(buildHostedTrainingReport({
      job, events, outputs, versionBeforeRead: before.version, generatedAt: new Date().toISOString(),
    }), target);
    return;
  }
  if (action === "hosted-evaluation-tasks") {
    const evaluationId = optionString(options, "evaluationId");
    if (!evaluationId) throw new Error("hosted-evaluation-tasks requires --evaluation-id from hosted-artifacts.");
    const outputs = await client.outputs(target);
    const evaluation = outputs.outputs.find(output => output.kind === "evaluation" && output.id === evaluationId);
    if (!evaluation) throw new Error("Evaluation does not belong to this job's retained outputs.");
    print(await client.evaluationTasks(target, { id: evaluation.id, contentHash: evaluation.contentHash }, {
      cursor: optionString(options, "cursor") || undefined,
    }));
    return;
  }
  if (action === "hosted-trajectory") {
    const trajectoryId = optionString(options, "trajectoryId");
    if (!trajectoryId) throw new Error("hosted-trajectory requires --trajectory-id <receipt-id> from hosted-inspect.");
    const response = await request(new URL(`/v1/managed-rl/jobs/${encodeURIComponent(target)}/trajectories/${encodeURIComponent(trajectoryId)}`, baseUrl), { headers });
    if (!response.ok) throw new Error(`Hosted trajectory read failed (${response.status}).`);
    print(await response.json()); return;
  }
  if (action === "hosted-inspect") {
    const response = await request(new URL(`/v1/managed-rl/jobs/${encodeURIComponent(target)}`, baseUrl), { headers });
    if (!response.ok) throw new Error(`Hosted job inspection failed (${response.status}).`);
    print(await response.json()); return;
  }
  if (action === "hosted-cancel") {
    await printAttached(await cancelHostedTrainingJob(client, target, teamId),target); return;
  }
  if (action === "hosted-artifacts") { await printAttached(await client.outputs(target),target); return; }
  if (action === "hosted-logs") { await printAttached(await client.logs(target),target); return; }
  if (action === "hosted-events") { await printAttached(await client.events(target),target); return; }
  if (action === "hosted-watch" && watchOptions) {
    await attach(target);
    await watchHostedTrainingJob({ client, jobId: target, teamId, options: watchOptions, print, requestBound });
    return;
  }
  throw new Error(`Unknown hosted training command: ${action}`);
}

async function accountContext(options: Options) {
  // Credential-store reconciliation can briefly overlap another CLI or app.
  // Retry only this local read; never automatically repeat a paid submission.
  for (let attempt = 0; ; attempt++) {
    try { return await loadOpenPondAccountContext(optionString(options, "account")); }
    catch (error) {
      const issue = (error as { issue?: { code?: string } }).issue;
      if (issue?.code !== "STORAGE_BUSY" || attempt >= 29) throw error;
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  }
}
