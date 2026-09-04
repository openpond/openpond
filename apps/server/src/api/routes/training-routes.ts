import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { readJson, sendBinary, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";
import {
  streamTrainingArtifactPackage,
  trainingArtifactPackageSize,
  type TrainingArtifactPackage,
} from "../../training/training-artifact-package.js";

export async function handleTrainingRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  if (!requestUrl.pathname.startsWith("/v1/training")) return false;
  if (request.method === "GET" && requestUrl.pathname === "/v1/training") {
    sendJson(response, 200, await deps.trainingPayload("state", {}, requestUrl));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/training/activity") {
    sendJson(response, 200, await deps.trainingPayload("activity", {}, requestUrl));
    return true;
  }
  if (
    request.method === "GET"
    && requestUrl.pathname === "/v1/training/catalog"
  ) {
    sendJson(
      response,
      200,
      await deps.trainingPayload("portable_catalog", {}, requestUrl),
    );
    return true;
  }
  if (
    request.method === "GET"
    && requestUrl.pathname === "/v1/training/hosted-model-projects"
  ) {
    sendJson(
      response,
      200,
      await deps.trainingPayload(
        "hosted_model_projects",
        {
          profileId: requestUrl.searchParams.get("profileId"),
          refresh: requestUrl.searchParams.get("refresh") === "true",
        },
        requestUrl,
      ),
    );
    return true;
  }
  if (
    request.method === "GET"
    && requestUrl.pathname === "/v1/training/datasets"
  ) {
    sendJson(
      response,
      200,
      await deps.trainingPayload("dataset_catalog", {}, requestUrl),
    );
    return true;
  }
  const downloadMatch = /^\/v1\/training\/artifacts\/([^/]+)\/download$/.exec(requestUrl.pathname);
  if (request.method === "GET" && downloadMatch) {
    const result = await deps.trainingPayload("artifact_download", { artifactId: decodeURIComponent(downloadMatch[1]!) }, requestUrl) as { artifact: { path: string; sizeBytes: number }; path: string };
    const info = await stat(result.path);
    if (!info.isFile() || info.size !== result.artifact.sizeBytes) throw new Error("Training artifact changed before download.");
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(info.size), "Content-Disposition": `attachment; filename="${path.basename(result.path).replaceAll('"', '')}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    createReadStream(result.path).pipe(response);
    return true;
  }
  const modelDownloadMatch = /^\/v1\/training\/models\/([^/]+)\/download$/.exec(requestUrl.pathname);
  if (request.method === "GET" && modelDownloadMatch) {
    const result = await deps.trainingPayload(
      "model_package_download",
      { modelId: decodeURIComponent(modelDownloadMatch[1]!) },
      requestUrl,
    ) as TrainingArtifactPackage;
    response.writeHead(200, {
      "Content-Type": "application/x-tar",
      "Content-Length": String(trainingArtifactPackageSize(result)),
      "Content-Disposition": `attachment; filename="${result.filename.replaceAll('"', "")}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    await streamTrainingArtifactPackage(response, result);
    return true;
  }
  const bundleDownloadMatch = /^\/v1\/training\/bundles\/([^/]+)\/download$/.exec(requestUrl.pathname);
  if (request.method === "GET" && bundleDownloadMatch) {
    const result = await deps.trainingPayload("export_bundle", { bundleId: decodeURIComponent(bundleDownloadMatch[1]!) }, requestUrl) as { filename: string; content: string };
    response.setHeader("Content-Disposition", `attachment; filename="${result.filename.replaceAll('"', '')}"`);
    sendBinary(response, 200, Buffer.from(result.content, "utf8"), "application/vnd.openpond.training-bundle+json");
    return true;
  }
  const routes: Array<{ method: string; path: string; action: string; status?: number }> = [
    { method: "POST", path: "/v1/training/sources", action: "add_source", status: 201 },
    { method: "POST", path: "/v1/training/sources/batch", action: "add_sources", status: 201 },
    { method: "POST", path: "/v1/training/sources/estimate", action: "estimate_sources" },
    { method: "POST", path: "/v1/training/sources/search", action: "search_sources" },
    { method: "POST", path: "/v1/training/dataset-imports/huggingface/inspect", action: "inspect_huggingface_dataset", status: 201 },
    { method: "POST", path: "/v1/training/harness-reviews/accept", action: "accept_harness_review", status: 201 },
    { method: "POST", path: "/v1/training/task-creations", action: "start_creation", status: 201 },
    { method: "POST", path: "/v1/training/taskset-drafts", action: "init_taskset_draft", status: 201 },
    { method: "POST", path: "/v1/training/taskset-drafts/import", action: "import_taskset_draft_package", status: 201 },
    { method: "POST", path: "/v1/training/models/from-taskset", action: "create_model_from_taskset", status: 201 },
    { method: "PUT", path: "/v1/training/models", action: "save_model_project" },
    { method: "POST", path: "/v1/training/comparison-series", action: "save_model_comparison_series", status: 201 },
    { method: "PUT", path: "/v1/training/continual-support/issue-reviews", action: "save_continual_support_issue_review" },
    { method: "POST", path: "/v1/training/continual-learning/daily-batches/import", action: "import_continual_learning_daily_batch", status: 201 },
    { method: "POST", path: "/v1/training/continual-learning/responses", action: "generate_continual_learning_responses", status: 202 },
    { method: "PUT", path: "/v1/training/continual-learning/daily-batches", action: "save_continual_learning_daily_batch" },
    { method: "POST", path: "/v1/training/miner/run", action: "run_miner", status: 202 },
    { method: "PUT", path: "/v1/training/miner/config", action: "configure_miner" },
    { method: "POST", path: "/v1/training/grade", action: "grade" },
    { method: "POST", path: "/v1/training/scorers", action: "create_scorer", status: 201 },
    { method: "POST", path: "/v1/training/audit-graders", action: "audit_graders" },
    { method: "POST", path: "/v1/training/calibrate-judges", action: "calibrate_judges" },
    { method: "POST", path: "/v1/training/readiness", action: "readiness" },
    { method: "POST", path: "/v1/training/plans", action: "create_plan", status: 201 },
    { method: "POST", path: "/v1/training/bundles", action: "build_bundle", status: 201 },
    { method: "POST", path: "/v1/training/approvals", action: "approve_training", status: 201 },
    { method: "POST", path: "/v1/training/launch", action: "launch", status: 202 },
    { method: "POST", path: "/v1/training/prepare", action: "prepare_start", status: 201 },
    { method: "POST", path: "/v1/training/start/prepared", action: "start_prepared", status: 202 },
    { method: "POST", path: "/v1/training/start", action: "start", status: 202 },
    { method: "POST", path: "/v1/training/credentials", action: "save_credential" },
  ];
  const route = routes.find((item) => item.method === request.method && item.path === requestUrl.pathname);
  if (route) {
    sendJson(response, route.status ?? 200, await deps.trainingPayload(route.action, await readJson(request), requestUrl));
    return true;
  }
  const dynamic = [
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/graders$/, method: "GET", action: "taskset_grader_details", key: "tasksetId" },
    { pattern: /^\/v1\/training\/model-runs\/([^/]+)\/attempts\/([^/]+)\/evidence$/, method: "GET", action: "model_comparison_attempt_evidence", key: "runId", assignmentKey: "attemptId" },
    { pattern: /^\/v1\/training\/comparison-series\/([^/]+)\/seal$/, method: "POST", action: "seal_model_comparison_series", key: "seriesId" },
    { pattern: /^\/v1\/training\/comparison-series\/([^/]+)\/archive$/, method: "POST", action: "archive_model_comparison_series", key: "seriesId" },
    { pattern: /^\/v1\/training\/comparison-series\/([^/]+)\/releases$/, method: "POST", action: "queue_model_comparison_release", key: "seriesId" },
    { pattern: /^\/v1\/training\/comparison-series-entries\/([^/]+)\/run$/, method: "PATCH", action: "link_model_comparison_run", key: "entryId" },
    { pattern: /^\/v1\/training\/comparison-series-entries\/([^/]+)\/evaluations$/, method: "POST", action: "start_model_comparison_evaluation", key: "entryId" },
    { pattern: /^\/v1\/training\/comparison-series\/([^/]+)\/reference-evaluations$/, method: "POST", action: "start_model_comparison_reference_evaluation", key: "seriesId" },
    { pattern: /^\/v1\/training\/comparison-series-entries\/([^/]+)\/retry$/, method: "POST", action: "retry_model_comparison_entry", key: "entryId" },
    { pattern: /^\/v1\/training\/comparison-series-entries\/([^/]+)\/decision$/, method: "POST", action: "decide_model_comparison_entry", key: "entryId" },
    { pattern: /^\/v1\/training\/comparison-series-entries\/([^/]+)\/promotion$/, method: "POST", action: "record_model_comparison_promotion", key: "entryId" },
    { pattern: /^\/v1\/training\/model-projects\/([^/]+)\/training\/prepare$/, method: "POST", action: "prepare_model_run", key: "modelProjectId" },
    { pattern: /^\/v1\/training\/model-projects\/([^/]+)\/training\/start$/, method: "POST", action: "start_model_run", key: "modelProjectId" },
    { pattern: /^\/v1\/training\/model-runs\/([^/]+)\/status$/, method: "GET", action: "model_run_status", key: "modelRunId" },
    { pattern: /^\/v1\/training\/model-runs\/([^/]+)\/events$/, method: "GET", action: "model_run_events", key: "modelRunId" },
    { pattern: /^\/v1\/training\/model-runs\/([^/]+)\/logs$/, method: "GET", action: "model_run_logs", key: "modelRunId" },
    { pattern: /^\/v1\/training\/model-runs\/([^/]+)\/artifacts$/, method: "GET", action: "model_run_artifacts", key: "modelRunId" },
    { pattern: /^\/v1\/training\/model-runs\/([^/]+)\/cancel$/, method: "POST", action: "cancel_model_run", key: "modelRunId" },
    { pattern: /^\/v1\/training\/model-runs\/([^/]+)\/resume$/, method: "POST", action: "resume_model_run", key: "modelRunId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/rows$/, method: "GET", action: "dataset_rows", key: "tasksetId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/operations$/, method: "GET", action: "taskset_operational_state", key: "tasksetId" },
    { pattern: /^\/v1\/training\/taskset-drafts\/([^/]+)\/workspace$/, method: "GET", action: "taskset_draft_workspace", key: "draftId" },
    { pattern: /^\/v1\/training\/taskset-drafts\/([^/]+)$/, method: "PUT", action: "save_taskset_draft", key: "draftId", wrap: "draft" },
    { pattern: /^\/v1\/training\/taskset-drafts\/([^/]+)\/publish$/, method: "POST", action: "publish_taskset_draft", key: "draftId" },
    { pattern: /^\/v1\/training\/taskset-drafts\/([^/]+)$/, method: "DELETE", action: "delete_taskset_draft", key: "draftId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/attempts$/, method: "POST", action: "execute_taskset_attempt", key: "tasksetId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/synthetic-collection$/, method: "POST", action: "materialize_synthetic_collection", key: "tasksetId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/synthetic-preference-collection$/, method: "POST", action: "materialize_synthetic_preference_collection", key: "tasksetId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/preference-comparisons$/, method: "GET", action: "preference_comparison_list", key: "tasksetId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/preference-comparisons$/, method: "POST", action: "preference_comparison_publish", key: "tasksetId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/preference-comparisons\/calibration\/status$/, method: "GET", action: "preference_comparison_calibration_status", key: "tasksetId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/preference-comparisons\/calibration\/batches$/, method: "POST", action: "preference_comparison_calibration_start", key: "tasksetId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/preference-comparisons\/calibration\/batches\/([^/]+)\/sync$/, method: "POST", action: "preference_comparison_calibration_sync", key: "tasksetId", assignmentKey: "jobId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/preference-comparisons\/calibration\/model-reviews\/next$/, method: "POST", action: "preference_comparison_calibration_review_next", key: "tasksetId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/preference-comparisons\/calibration\/report$/, method: "POST", action: "preference_comparison_calibration_save", key: "tasksetId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/preference-comparisons\/assignments$/, method: "POST", action: "preference_comparison_create_assignment", key: "tasksetId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/preference-comparisons\/next$/, method: "POST", action: "preference_comparison_next", key: "tasksetId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/preference-comparisons\/([^/]+)\/submit$/, method: "POST", action: "preference_comparison_submit", key: "tasksetId", assignmentKey: "assignmentId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/preference-comparisons\/([^/]+)\/fixture-submit$/, method: "POST", action: "preference_comparison_fixture_submit", key: "tasksetId", assignmentKey: "assignmentId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/preference-comparisons\/([^/]+)\/model-review$/, method: "POST", action: "preference_comparison_model_review", key: "tasksetId", assignmentKey: "assignmentId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/preference-comparisons\/([^/]+)\/unreviewable$/, method: "POST", action: "preference_comparison_unreviewable", key: "tasksetId", assignmentKey: "assignmentId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/benchmark-runs$/, method: "POST", action: "run_taskset_benchmark", key: "tasksetId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/preference-datasets$/, method: "GET", action: "preference_dataset_list", key: "tasksetId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/preference-datasets$/, method: "POST", action: "preference_dataset_materialize", key: "tasksetId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/reward-model-runs$/, method: "POST", action: "reward_model_run_launch", key: "tasksetId" },
    { pattern: /^\/v1\/training\/reward-model-runs\/([^/]+)\/retry-qualification$/, method: "POST", action: "reward_model_qualification_retry", key: "runId" },
    { pattern: /^\/v1\/training\/reward-model-runs\/([^/]+)\/cancel$/, method: "POST", action: "reward_model_run_cancel", key: "runId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/learned-preference-reward-binding$/, method: "POST", action: "learned_preference_reward_binding", key: "tasksetId" },
    { pattern: /^\/v1\/training\/models\/([^/]+)\/harness-refiner-benchmark$/, method: "POST", action: "start_harness_refiner_benchmark", key: "modelId" },
    { pattern: /^\/v1\/training\/hosted-model-projects\/([^/]+)\/pull$/, method: "POST", action: "pull_hosted_model_project", key: "hostedProjectId" },
    { pattern: /^\/v1\/training\/models\/([^/]+)\/sync$/, method: "POST", action: "sync_model_project", key: "modelId" },
    { pattern: /^\/v1\/training\/models\/([^/]+)\/managed-base$/, method: "POST", action: "version_model_project_onto_managed_rl_base", key: "modelProjectId" },
    { pattern: /^\/v1\/training\/models\/([^/]+)\/tasksets\/([^/]+)\/publish$/, method: "POST", action: "publish_model_project_taskset", key: "modelId", assignmentKey: "tasksetId" },
    { pattern: /^\/v1\/training\/dataset-imports\/([^/]+)\/materialize$/, method: "POST", action: "materialize_dataset_import", key: "importId" },
    { pattern: /^\/v1\/training\/dataset-imports\/([^/]+)\/cancel$/, method: "POST", action: "cancel_dataset_import", key: "importId" },
    { pattern: /^\/v1\/training\/sources\/([^/]+)$/, method: "DELETE", action: "remove_source", key: "sourceId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)$/, method: "DELETE", action: "delete_taskset", key: "tasksetId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/expert-bootstrap\/preview$/, method: "POST", action: "preview_expert_bootstrap", key: "tasksetId" },
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/expert-bootstrap\/approve$/, method: "POST", action: "approve_expert_bootstrap", key: "tasksetId" },
    { pattern: /^\/v1\/training\/task-creations\/([^/]+)\/disclosure$/, method: "POST", action: "approve_disclosure", key: "creationId" },
    { pattern: /^\/v1\/training\/task-creations\/([^/]+)\/retry$/, method: "POST", action: "retry_creation", key: "creationId" },
    { pattern: /^\/v1\/training\/task-creations\/([^/]+)\/questions$/, method: "POST", action: "answer_questions", key: "creationId" },
    { pattern: /^\/v1\/training\/task-creations\/([^/]+)\/materialize$/, method: "POST", action: "approve_materialization", key: "creationId" },
    { pattern: /^\/v1\/training\/task-creations\/([^/]+)\/chat$/, method: "POST", action: "chat_creation", key: "creationId" },
    { pattern: /^\/v1\/training\/task-creations\/([^/]+)\/name$/, method: "PATCH", action: "rename_creation", key: "creationId" },
    { pattern: /^\/v1\/training\/task-creations\/([^/]+)\/cancel$/, method: "POST", action: "cancel_creation", key: "creationId" },
    { pattern: /^\/v1\/training\/miner\/runs\/([^/]+)\/cancel$/, method: "POST", action: "cancel_miner_run", key: "runId" },
    { pattern: /^\/v1\/training\/candidates\/([^/]+)$/, method: "PATCH", action: "patch_candidate", key: "candidateId", wrap: "patch" },
    { pattern: /^\/v1\/training\/candidates\/([^/]+)\/create$/, method: "POST", action: "create_candidate", key: "candidateId" },
    { pattern: /^\/v1\/training\/jobs\/([^/]+)\/cancel$/, method: "POST", action: "cancel_job", key: "jobId" },
    { pattern: /^\/v1\/training\/jobs\/([^/]+)\/events$/, method: "GET", action: "job_events", key: "jobId" },
    { pattern: /^\/v1\/training\/jobs\/([^/]+)\/detail$/, method: "GET", action: "run_detail", key: "jobId" },
    { pattern: /^\/v1\/training\/models\/([^/]+)\/reject$/, method: "POST", action: "reject_model", key: "modelId" },
    { pattern: /^\/v1\/training\/models\/([^/]+)\/bind$/, method: "POST", action: "bind_model", key: "modelId" },
    { pattern: /^\/v1\/training\/bindings\/([^/]+)\/rollback$/, method: "POST", action: "rollback_model_binding", key: "bindingId" },
    { pattern: /^\/v1\/training\/models\/([^/]+)\/configuration$/, method: "PATCH", action: "update_model_configuration", key: "modelId", wrap: "configuration" },
    { pattern: /^\/v1\/training\/models\/([^/]+)\/pin$/, method: "PATCH", action: "set_model_pinned", key: "modelId" },
  ];
  for (const item of dynamic) {
    const match = item.pattern.exec(requestUrl.pathname);
    if (!match || request.method !== item.method) continue;
    const body = request.method === "GET" || request.method === "DELETE" ? {} : await readJson(request);
    const payload = {
      ...(item.wrap ? { [item.wrap]: body } : record(body)),
      [item.key]: decodeURIComponent(match[1]!),
      ...(item.assignmentKey ? { [item.assignmentKey]: decodeURIComponent(match[2]!) } : {}),
      ...(item.action === "model_comparison_attempt_evidence" ? { kind: requestUrl.searchParams.get("kind") } : {}),
      ...(item.action === "run_detail" ? { includeEvaluation: requestUrl.searchParams.get("evaluation") !== "false" } : {}),
    };
    const controller = new AbortController();
    request.once("aborted", () => controller.abort(new Error("training_request_aborted")));
    response.once("close", () => {
      if (!response.writableEnded) controller.abort(new Error("training_response_closed"));
    });
    sendJson(response, 200, await deps.trainingPayload(item.action, payload, requestUrl, controller.signal));
    return true;
  }
  return false;
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
