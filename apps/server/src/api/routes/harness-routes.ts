import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleHarnessRoutes({
  deps,
  request,
  requestUrl,
  response,
}: HttpRouteContext): Promise<boolean> {
  if (request.method === "GET" && requestUrl.pathname === "/v1/harness") {
    sendJson(response, 200, await deps.harnessHistoryPayload());
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/harness/background-review") {
    sendJson(response, 200, await deps.updateHarnessBackgroundReviewPayload(await readJson(request)));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/harness/evaluation-review") {
    sendJson(response, 200, await deps.reviewHarnessEvaluationPayload(await readJson(request)));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/harness/evaluation-review/settings") {
    sendJson(
      response,
      200,
      await deps.updateHarnessEvaluationReviewSchedulePayload(await readJson(request)),
    );
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/harness/diff") {
    sendJson(response, 200, await deps.harnessDiffPayload(await readJson(request)));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/harness/rollback") {
    sendJson(response, 200, await deps.rollbackHarnessPayload(await readJson(request)));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/harness/review") {
    sendJson(response, 200, await deps.reviewHarnessProposalPayload(await readJson(request)));
    return true;
  }
  return false;
}
