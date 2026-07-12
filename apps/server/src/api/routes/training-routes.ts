import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { readJson, sendBinary, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleTrainingRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  if (!requestUrl.pathname.startsWith("/v1/training")) return false;
  if (request.method === "GET" && requestUrl.pathname === "/v1/training") {
    sendJson(response, 200, await deps.trainingPayload("state", {}, requestUrl));
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
    { method: "POST", path: "/v1/training/task-creations", action: "start_creation", status: 201 },
    { method: "POST", path: "/v1/training/miner/run", action: "run_miner", status: 202 },
    { method: "PUT", path: "/v1/training/miner/config", action: "configure_miner" },
    { method: "POST", path: "/v1/training/grade", action: "grade" },
    { method: "POST", path: "/v1/training/baseline", action: "baseline", status: 202 },
    { method: "POST", path: "/v1/training/audit-graders", action: "audit_graders" },
    { method: "POST", path: "/v1/training/calibrate-judges", action: "calibrate_judges" },
    { method: "POST", path: "/v1/training/readiness", action: "readiness" },
    { method: "POST", path: "/v1/training/plans", action: "create_plan", status: 201 },
    { method: "POST", path: "/v1/training/bundles", action: "build_bundle", status: 201 },
    { method: "POST", path: "/v1/training/approvals", action: "approve_training", status: 201 },
    { method: "POST", path: "/v1/training/launch", action: "launch", status: 202 },
    { method: "POST", path: "/v1/training/import", action: "import_artifact", status: 202 },
    { method: "POST", path: "/v1/training/credentials", action: "save_credential" },
  ];
  const route = routes.find((item) => item.method === request.method && item.path === requestUrl.pathname);
  if (route) {
    sendJson(response, route.status ?? 200, await deps.trainingPayload(route.action, await readJson(request), requestUrl));
    return true;
  }
  const dynamic = [
    { pattern: /^\/v1\/training\/sources\/([^/]+)$/, method: "DELETE", action: "remove_source", key: "sourceId" },
    { pattern: /^\/v1\/training\/task-creations\/([^/]+)\/disclosure$/, method: "POST", action: "approve_disclosure", key: "creationId" },
    { pattern: /^\/v1\/training\/task-creations\/([^/]+)\/questions$/, method: "POST", action: "answer_questions", key: "creationId" },
    { pattern: /^\/v1\/training\/task-creations\/([^/]+)\/materialize$/, method: "POST", action: "approve_materialization", key: "creationId" },
    { pattern: /^\/v1\/training\/task-creations\/([^/]+)\/chat$/, method: "POST", action: "chat_creation", key: "creationId" },
    { pattern: /^\/v1\/training\/candidates\/([^/]+)$/, method: "PATCH", action: "patch_candidate", key: "candidateId", wrap: "patch" },
    { pattern: /^\/v1\/training\/candidates\/([^/]+)\/create$/, method: "POST", action: "create_candidate", key: "candidateId" },
    { pattern: /^\/v1\/training\/jobs\/([^/]+)\/cancel$/, method: "POST", action: "cancel_job", key: "jobId" },
    { pattern: /^\/v1\/training\/jobs\/([^/]+)\/events$/, method: "GET", action: "job_events", key: "jobId" },
    { pattern: /^\/v1\/training\/models\/([^/]+)\/reject$/, method: "POST", action: "reject_model", key: "modelId" },
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
