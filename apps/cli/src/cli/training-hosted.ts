import { attachHostedTrainingToChat } from "./training-chat-attachment";
import { readFile } from "node:fs/promises";
import { hostedTrainingAccount } from "./hosted-training-account";
import { createTrainingClient, OpenPondTrainingApiError, parseAndVerifyTrainingJobSubmission, parseAndVerifyTrainingPreparationReceipt, TrainingPreparationRequestSchema, type TrainingInputArtifactUpload } from "openpond-sdk/training";
import { createModelProjectsClient, HostedModelProjectSyncSchema } from "openpond-sdk/model-projects";
import { OpenPondCorrectionMetricsClient, OpenPondLearningClient } from "openpond-sdk/learning";
import { optionString, parseBooleanOption, parseIntegerOption } from "./common/options";
import { cancelHostedTrainingJob, parseHostedWatchOptions, stopHostedTrainingJobAfterGroup, watchHostedTrainingJob } from "./training-hosted-lifecycle";
import { printTrainingEstimate } from "./training-estimate-output";

type Options = Record<string, string | boolean>;
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

/** Hosted operations use the public SDK and account credential store directly.
 * They never start or depend on the local app server. App-scoped chat invocations
 * additionally attempt a recoverable attachment after successful operations. */
export async function runHostedTrainingCommand(options: Options, rest: string[]): Promise<void> {
  const action = rest[0], target = rest[1];
  const watchOptions = action === "hosted-watch" ? parseHostedWatchOptions(options) : null;
  const requestBound = { deadlineAt: watchOptions?.deadlineAt ?? null };
  const { context, baseUrl, teamId, headers } = await hostedTrainingAccount(options);
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
  const readNativeInspection = async (jobId: string): Promise<unknown> => {
    const response = await request(new URL(`/v1/managed-rl/jobs/${encodeURIComponent(jobId)}`, baseUrl), { headers });
    if (!response.ok) throw new OpenPondTrainingApiError(response.status, {
      schemaVersion: "openpond.trainingApiError.v2", code: "inspection_failed",
      message: `Hosted job inspection failed (${response.status}).`,
      retryable: response.status === 429 || response.status >= 500, requestId: null, details: {},
    });
    return response.json();
  };
  if (rest.length > 2) throw new Error(`${action} accepts at most one identifier or input file.`);
  if (["hosted-serving-pools", "hosted-base-serving-prepare", "hosted-serving-pool-retire"].includes(action ?? "")) {
    print(await (await import("./training-hosted-serving")).runHostedServingCommand({
      action: action!, target, baseUrl, headers, request, readInput,
      confirmed: parseBooleanOption(options.yes),
    })); return;
  }
  if (action === "hosted-evaluate-checkpoint") {
    if (!parseBooleanOption(options.yes)) throw new Error("Paid checkpoint evaluation requires --yes.");
    const input = (await import("./training-hosted-checkpoint-evaluation")).parseCheckpointEvaluationRequest(await readInput());
    const jsonHeaders = new Headers(headers);
    jsonHeaders.set("content-type", "application/json");
    const response = await request(new URL("/v1/managed-rl/serving-soaks", baseUrl), {
      method: "POST", headers: jsonHeaders, body: JSON.stringify(input),
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const code = value && typeof value === "object" && "error" in value ? String(value.error) : "checkpoint_evaluation_failed";
      throw new Error(`Checkpoint evaluation failed (${response.status}): ${code}. Reconcile hosted-jobs before retrying the same immutable request.`);
    }
    const result = (await import("./training-hosted-checkpoint-evaluation")).parseCheckpointEvaluationResponse(value, input);
    await printAttached(result, result.job.id); return;
  }
  if (action === "hosted-provider" || action === "hosted-quotes") {
    if (target) throw new Error(`${action} does not accept an identifier.`);
    const path = action === "hosted-provider" ? "/v1/managed-rl/provider-inventory" : "/v1/managed-rl/quotes";
    const response = await request(new URL(path, baseUrl), { headers });
    const value: unknown = await response.json();
    if (!response.ok) throw new Error(`Hosted capacity read failed (${response.status}).`);
    print(value); return;
  }
  if (action === "hosted-hardware") {
    if (target) throw new Error("hosted-hardware does not accept an identifier; use --worker-id or --job-id.");
    print(await client.hardwareObservations({ teamId,
      workerId: optionString(options, "workerId") || undefined, jobId: optionString(options, "jobId") || undefined,
      cursor: optionString(options, "cursor") || undefined,
      limit: options.limit === undefined ? undefined : parseIntegerOption(options.limit, "limit"),
    })); return;
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
  if (action === "hosted-corrections" || action === "hosted-learning-inspect") {
    if (!target) throw new Error(`${action} requires a hosted Model Project ID.`);
    const { project } = await createModelProjectsClient({ baseUrl, headers, fetch: request }).get(target);
    print(await (await import("./training-hosted-learning")).inspectHostedLearning({
      action, options, teamId, model: project,
      learning: new OpenPondLearningClient({ baseUrl, apiKey: context.token, scope: teamId, fetch: request }),
      corrections: new OpenPondCorrectionMetricsClient({ baseUrl, apiKey: context.token, fetch: request }),
    })); return;
  }
  if (action === "hosted-sync-model") {
    const input = HostedModelProjectSyncSchema.parse(await readInput());
    print(await createModelProjectsClient({ baseUrl, headers, fetch: request }).upsert(input)); return;
  }
  if (action === "hosted-publish-taskset") {
    const { OpenPondTasksetPackageClient, TasksetPackagePublicationSchema } = await import("openpond-sdk/taskset-packages");
    const input = TasksetPackagePublicationSchema.parse(await readInput());
    print(await new OpenPondTasksetPackageClient({ baseUrl, apiKey: context.token, teamId, fetch: request }).publish(input)); return;
  }
  if (action === "hosted-capabilities") { print(await client.capabilities()); return; }
  if (action === "hosted-gpu-catalog") { print(await client.gpuCatalog()); return; }
  if (action === "hosted-start-model") {
    if (!target) throw new Error("training start requires a saved hosted Model Project ID.");
    const result = await (await import("./training-model-start")).startHostedModel({
      options, modelId: target, teamId, client,
      models: createModelProjectsClient({ baseUrl, headers, fetch: request }),
      learning: new OpenPondLearningClient({ baseUrl, apiKey: context.token, scope: teamId, fetch: request }),
    });
    print(result);
    if (result.preparation.jobId) await attach(result.preparation.jobId);
    if (result.preparation.jobId && !parseBooleanOption(options.detach)) {
      await watchHostedTrainingJob({ client, jobId: result.preparation.jobId, teamId,
        options: parseHostedWatchOptions(options), print, requestBound, readNativeInspection });
    }
    return;
  }
  if (action === "hosted-estimate-model") {
    if (!target) throw new Error("training estimate requires a hosted Model Project ID.");
    const { project } = await createModelProjectsClient({ baseUrl, headers, fetch: request }).get(target);
    const batchId = optionString(options, "batchId");
    const batch = batchId ? await new OpenPondLearningClient({ baseUrl, apiKey: context.token, scope: teamId, fetch: request }).get("batch", batchId) : null;
    const { trainingGpuChoice } = await import("./training-model-start");
    const gpuSelection = trainingGpuChoice(options) ?? project.trainingSetup.managedGpuSelection;
    printTrainingEstimate(await client.estimate({
      schemaVersion: "openpond.trainingEstimateRequest.v1", teamId,
      source: { kind: "configuration", id: project.id, expectedRevision: project.revision, expectedEtag: project.etag,
        batch: batch ? { id: batch.id, revision: batch.revision, contentHash: batch.contentHash } : null },
      ...(gpuSelection ? { gpuSelection } : {}),
    }), parseBooleanOption(options.json));
    return;
  }
  if (action === "hosted-estimate") {
    const { TrainingEstimateRequestSchema } = await import("openpond-sdk/training");
    const input = TrainingEstimateRequestSchema.parse(await readInput());
    if (input.teamId !== teamId) throw new Error("Estimate input belongs to a different workspace.");
    printTrainingEstimate(await client.estimate(input), parseBooleanOption(options.json));
    return;
  }
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
    if (input.gpuSelection?.gpuCount === 2 || input.job.kind === "policy_optimize" && input.job.executionMode === "qualification") {
      const capabilities = await client.capabilities();
      if (input.gpuSelection?.gpuCount === 2 && !capabilities.policyDataParallel) {
        throw new Error("This hosted runtime has no qualified two-GPU policy-training image.");
      }
      if (input.job.kind === "policy_optimize" && input.job.executionMode === "qualification" && !capabilities.executionModes?.includes("qualification")) {
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
    const recoverySourceJob = job.recovery ? await client.getJob(job.recovery.sourceJobId) : undefined;
    const servingEvidence = job.rolloutProgress.groupsTarget === 0
      ? (await import("./training-hosted-serving-report")).parseHostedServingReportEvidence(await readNativeInspection(target), job)
      : undefined;
    const { buildHostedTrainingReport } = await import("./training-hosted-report");
    await printAttached(buildHostedTrainingReport({
      job, events, outputs, recoverySourceJob, servingEvidence, versionBeforeRead: before.version, generatedAt: new Date().toISOString(),
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
      limit: parseIntegerOption(options.limit, "--limit"),
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
  if (action === "hosted-feedback") {
    const { readHostedGraderFeedback } = await import("./training-hosted-feedback");
    print(await readHostedGraderFeedback({
      jobId: target, baseUrl, headers, request,
      trajectoryId: optionString(options, "trajectoryId") || undefined,
      evaluationId: optionString(options, "evaluationId") || undefined,
      taskId: optionString(options, "taskId") || undefined,
    }));
    return;
  }
  if (action === "hosted-inspect") {
    print(await readNativeInspection(target)); return;
  }
  if (action === "hosted-recover") {
    if (!parseBooleanOption(options.yes)) throw new Error("hosted-recover requires --yes for its explicit funded execution request.");
    const { jobId, ...recovery } = await readInput();
    if (typeof jobId !== "string" || !jobId) throw new Error("hosted-recover requires jobId in its input JSON.");
    const recovered = await client.recoverCheckpoint(jobId, recovery);
    await printAttached(recovered, recovered.id); return;
  }
  if (action === "hosted-cancel") {
    await printAttached(await cancelHostedTrainingJob(client, target, teamId),target); return;
  }
  if (action === "hosted-stop-after-group") {
    if (!parseBooleanOption(options.yes)) throw new Error("hosted-stop-after-group requires --yes to shorten the admitted training schedule.");
    await printAttached(await stopHostedTrainingJobAfterGroup(client, target, teamId),target); return;
  }
  if (action === "hosted-artifacts") { await printAttached(await client.outputs(target),target); return; }
  if (action === "hosted-logs") { await printAttached(await client.logs(target),target); return; }
  if (action === "hosted-events") { await printAttached(await client.events(target),target); return; }
  if (action === "hosted-watch" && watchOptions) {
    await attach(target);
    await watchHostedTrainingJob({ client, jobId: target, teamId, options: watchOptions, print, requestBound, readNativeInspection });
    return;
  }
  throw new Error(`Unknown hosted training command: ${action}`);
}
