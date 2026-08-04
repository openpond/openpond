import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleLocalContinuousLearningRoutes({
  request,
  response,
  requestUrl,
  deps,
}: HttpRouteContext): Promise<boolean> {
    if (
      request.method === "GET"
      && requestUrl.pathname === "/v1/local-continuous-learning"
    ) {
      sendJson(response, 200, await deps.listLocalContinuousLearningPayload());
      return true;
    }
    if (
      request.method === "POST"
      && requestUrl.pathname === "/v1/local-continuous-learning/ensure"
    ) {
      sendJson(
        response,
        200,
        await deps.ensureLocalContinuousLearningPayload(await readJson(request)),
      );
      return true;
    }
    const consent = /^\/v1\/local-continuous-learning\/conversations\/([^/]+)\/consent$/
      .exec(requestUrl.pathname);
    if (request.method === "POST" && consent) {
      sendJson(
        response,
        200,
        await deps.setLocalConversationLearningConsentPayload(
          decodeURIComponent(consent[1]!),
          await readJson(request),
        ),
      );
      return true;
    }
    const cancel = /^\/v1\/local-continuous-learning\/([^/]+)\/runs\/([^/]+)\/cancel$/
      .exec(requestUrl.pathname);
    if (request.method === "POST" && cancel) {
      sendJson(
        response,
        202,
        await deps.cancelLocalContinuousLearningRunPayload(
          decodeURIComponent(cancel[1]!),
          decodeURIComponent(cancel[2]!),
        ),
      );
      return true;
    }
    const run = /^\/v1\/local-continuous-learning\/([^/]+)\/run$/
      .exec(requestUrl.pathname);
    if (request.method === "POST" && run) {
      sendJson(
        response,
        202,
        await deps.runLocalContinuousLearningPayload(
          decodeURIComponent(run[1]!),
        ),
      );
      return true;
    }
    const state = /^\/v1\/local-continuous-learning\/([^/]+)$/
      .exec(requestUrl.pathname);
    if (request.method === "PATCH" && state) {
      sendJson(
        response,
        200,
        await deps.patchLocalContinuousLearningPayload(
          decodeURIComponent(state[1]!),
          await readJson(request),
        ),
      );
      return true;
    }
    return false;
}
