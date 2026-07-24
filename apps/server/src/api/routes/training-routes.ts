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
    { method: "POST", path: "/v1/training/cross-system-operations/frontier-baseline", action: "run_cross_system_frontier_baseline", status: 202 },
    { method: "POST", path: "/v1/training/cross-system-operations/fixture-baseline", action: "record_cross_system_fixture_baseline", status: 201 },
    { method: "POST", path: "/v1/training/task-creations", action: "start_creation", status: 201 },
    { method: "POST", path: "/v1/training/models/from-taskset", action: "create_model_from_taskset", status: 201 },
    { method: "PUT", path: "/v1/training/models", action: "save_model_project" },
    { method: "PUT", path: "/v1/training/model-run-drafts", action: "save_model_run_draft" },
    { method: "POST", path: "/v1/training/miner/run", action: "run_miner", status: 202 },
    { method: "PUT", path: "/v1/training/miner/config", action: "configure_miner" },
    { method: "POST", path: "/v1/training/grade", action: "grade" },
    { method: "POST", path: "/v1/training/baseline", action: "baseline", status: 202 },
    { method: "POST", path: "/v1/training/baseline/regrade", action: "regrade_baseline" },
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
    { method: "POST", path: "/v1/training/import", action: "import_artifact", status: 202 },
    { method: "POST", path: "/v1/training/credentials", action: "save_credential" },
  ];
  const route = routes.find((item) => item.method === request.method && item.path === requestUrl.pathname);
  if (route) {
    sendJson(response, route.status ?? 200, await deps.trainingPayload(route.action, await readJson(request), requestUrl));
    return true;
  }
  const dynamic = [
    { pattern: /^\/v1\/training\/tasksets\/([^/]+)\/rows$/, method: "GET", action: "dataset_rows", key: "tasksetId" },
    { pattern: /^\/v1\/training\/model-run-drafts\/([^/]+)$/, method: "DELETE", action: "delete_model_run_draft", key: "draftId" },
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
    { pattern: /^\/v1\/training\/baseline\/runs\/([^/]+)\/cancel$/, method: "POST", action: "cancel_baseline_run", key: "runId" },
    { pattern: /^\/v1\/training\/cross-system-operations\/frontier-baseline\/runs\/([^/]+)\/cancel$/, method: "POST", action: "cancel_cross_system_frontier_baseline", key: "runId" },
    { pattern: /^\/v1\/training\/candidates\/([^/]+)$/, method: "PATCH", action: "patch_candidate", key: "candidateId", wrap: "patch" },
    { pattern: /^\/v1\/training\/candidates\/([^/]+)\/create$/, method: "POST", action: "create_candidate", key: "candidateId" },
    { pattern: /^\/v1\/training\/jobs\/([^/]+)\/cancel$/, method: "POST", action: "cancel_job", key: "jobId" },
    { pattern: /^\/v1\/training\/jobs\/([^/]+)\/evaluate$/, method: "POST", action: "evaluate_job", key: "jobId" },
    { pattern: /^\/v1\/training\/jobs\/([^/]+)\/events$/, method: "GET", action: "job_events", key: "jobId" },
    { pattern: /^\/v1\/training\/jobs\/([^/]+)\/detail$/, method: "GET", action: "run_detail", key: "jobId" },
    { pattern: /^\/v1\/training\/models\/([^/]+)\/reject$/, method: "POST", action: "reject_model", key: "modelId" },
    { pattern: /^\/v1\/training\/models\/([^/]+)\/bind$/, method: "POST", action: "bind_model", key: "modelId" },
    { pattern: /^\/v1\/training\/models\/([^/]+)\/serving$/, method: "POST", action: "start_model_serving", key: "modelId" },
    { pattern: /^\/v1\/training\/serving\/([^/]+)\/stop$/, method: "POST", action: "stop_model_serving", key: "servingSessionId" },
    { pattern: /^\/v1\/training\/bindings\/([^/]+)\/rollback$/, method: "POST", action: "rollback_model_binding", key: "bindingId" },
    { pattern: /^\/v1\/training\/models\/([^/]+)\/configuration$/, method: "PATCH", action: "update_model_configuration", key: "modelId", wrap: "configuration" },
    { pattern: /^\/v1\/training\/models\/([^/]+)\/pin$/, method: "PATCH", action: "set_model_pinned", key: "modelId" },
  ];
  for (const item of dynamic) {
    const match = item.pattern.exec(requestUrl.pathname);
    if (!match || request.method !== item.method) continue;
    const body = request.method === "GET" || request.method === "DELETE" ? {} : await readJson(request);
    const payload = { ...(item.wrap ? { [item.wrap]: body } : record(body)), [item.key]: decodeURIComponent(match[1]!) };
    sendJson(response, 200, await deps.trainingPayload(item.action, payload, requestUrl));
    return true;
  }
  return false;
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
