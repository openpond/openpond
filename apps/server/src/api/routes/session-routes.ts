import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleSessionRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  const {
    createSession,
    patchSession,
    sendTurn,
    runSessionCommand,
    ensureCloudWorkspaceReady,
    recordPreflightTurnFailure,
    updateTurnCreatePipeline,
    interruptSessionTurn,
    pauseSessionGoal,
    compactSession,
    executeWorkspaceTool,
    runSubagentLifecycleAction,
    resolveApproval,
  } = deps;
  if (request.method === "POST" && requestUrl.pathname === "/v1/sessions") {
    sendJson(response, 201, await createSession(await readJson(request)));
    return true;
  }
  const sessionPatchMatch = /^\/v1\/sessions\/([^/]+)$/.exec(requestUrl.pathname);
  if (request.method === "PATCH" && sessionPatchMatch) {
    sendJson(response, 200, await patchSession(sessionPatchMatch[1]!, await readJson(request)));
    return true;
  }
  const turnMatch = /^\/v1\/sessions\/([^/]+)\/turns$/.exec(requestUrl.pathname);
  if (request.method === "POST" && turnMatch) {
    sendJson(response, 202, await sendTurn(turnMatch[1]!, await readJson(request)));
    return true;
  }
  const commandMatch = /^\/v1\/sessions\/([^/]+)\/commands$/.exec(requestUrl.pathname);
  if (request.method === "POST" && commandMatch) {
    sendJson(response, 202, await runSessionCommand(decodeURIComponent(commandMatch[1]!), await readJson(request)));
    return true;
  }
  const preflightFailureMatch =
    /^\/v1\/sessions\/([^/]+)\/preflight-turns\/failure$/.exec(requestUrl.pathname);
  if (request.method === "POST" && preflightFailureMatch) {
    sendJson(
      response,
      200,
      await recordPreflightTurnFailure(
        decodeURIComponent(preflightFailureMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  const workspaceReadyMatch = /^\/v1\/sessions\/([^/]+)\/workspace\/ensure-ready$/.exec(requestUrl.pathname);
  if (request.method === "POST" && workspaceReadyMatch) {
    sendJson(
      response,
      200,
      await ensureCloudWorkspaceReady(
        decodeURIComponent(workspaceReadyMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  const turnCreatePipelineMatch =
    /^\/v1\/sessions\/([^/]+)\/turns\/([^/]+)\/create-pipeline$/.exec(requestUrl.pathname);
  if (request.method === "POST" && turnCreatePipelineMatch) {
    sendJson(
      response,
      200,
      await updateTurnCreatePipeline(
        decodeURIComponent(turnCreatePipelineMatch[1]!),
        decodeURIComponent(turnCreatePipelineMatch[2]!),
        await readJson(request),
      ),
    );
    return true;
  }
  const turnInterruptMatch = /^\/v1\/sessions\/([^/]+)\/turns\/interrupt$/.exec(
    requestUrl.pathname,
  );
  if (request.method === "POST" && turnInterruptMatch) {
    sendJson(response, 202, await interruptSessionTurn(turnInterruptMatch[1]!));
    return true;
  }
  const goalPauseMatch = /^\/v1\/sessions\/([^/]+)\/goals\/pause$/.exec(requestUrl.pathname);
  if (request.method === "POST" && goalPauseMatch) {
    sendJson(response, 200, await pauseSessionGoal(decodeURIComponent(goalPauseMatch[1]!)));
    return true;
  }
  const compactMatch = /^\/v1\/sessions\/([^/]+)\/compact$/.exec(requestUrl.pathname);
  if (request.method === "POST" && compactMatch) {
    sendJson(response, 202, await compactSession(compactMatch[1]!, await readJson(request)));
    return true;
  }
  const workspaceToolMatch = /^\/v1\/sessions\/([^/]+)\/workspace-tools$/.exec(
    requestUrl.pathname,
  );
  if (request.method === "POST" && workspaceToolMatch) {
    sendJson(
      response,
      200,
      await executeWorkspaceTool(workspaceToolMatch[1]!, await readJson(request)),
    );
    return true;
  }
  const subagentLifecycleMatch = /^\/v1\/subagents\/([^/]+)\/lifecycle$/.exec(requestUrl.pathname);
  if (request.method === "POST" && subagentLifecycleMatch) {
    sendJson(
      response,
      200,
      await runSubagentLifecycleAction(
        decodeURIComponent(subagentLifecycleMatch[1]!),
        await readJson(request),
      ),
    );
    return true;
  }
  const approvalMatch = /^\/v1\/approvals\/([^/]+)$/.exec(requestUrl.pathname);
  if (request.method === "POST" && approvalMatch) {
    sendJson(response, 200, await resolveApproval(approvalMatch[1]!, await readJson(request)));
    return true;
  }
  return false;
}
