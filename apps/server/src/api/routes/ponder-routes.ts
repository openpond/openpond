import { ZodError } from "zod";
import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handlePonderRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  const path = requestUrl.pathname;
  if (path === "/v1/ponder/local" || path.startsWith("/v1/ponder/local/")) {
    try {
      const hosted=deps.localPonder.hosted;
      if(path === "/v1/ponder/local/hosted-sandboxes" && hosted){
        if(request.method==="GET"){sendJson(response,200,await hosted.status());return true;}
        if(request.method==="POST"){sendJson(response,200,await hosted.configure(await readJson(request)));return true;}
      }
      if(path === "/v1/ponder/local/hosted-inputs" && hosted && request.method==="POST"){const local=await deps.localPonder.readSnapshot();if(!local.session)throw new Error("local_ponder_unavailable");sendJson(response,201,await hosted.stageInput(local.session.id,await readJson(request)));return true;}
      if(path === "/v1/ponder/local/hosted-agents" && hosted){
        if(request.method==="GET"){sendJson(response,200,await hosted.list());return true;}
        if(request.method==="POST"){const local=await deps.localPonder.readSnapshot();if(!local.session)throw new Error("local_ponder_unavailable");sendJson(response,201,await hosted.start(local.session.id,await readJson(request)));return true;}
      }
      const hostedOutput=/^\/v1\/ponder\/local\/hosted-agents\/([^/]+)\/outputs\/([^/]+)$/.exec(path);
      if(hostedOutput&&hosted&&request.method==="GET"){sendJson(response,200,await hosted.output(decodeURIComponent(hostedOutput[1]!),decodeURIComponent(hostedOutput[2]!)));return true;}
      const hostedAgent=/^\/v1\/ponder\/local\/hosted-agents\/([^/]+)(\/cancel)?$/.exec(path);
      if(hostedAgent&&hosted){if(request.method==="GET"&&!hostedAgent[2]){sendJson(response,200,await hosted.detail(decodeURIComponent(hostedAgent[1]!)));return true;}if(request.method==="POST"&&hostedAgent[2]){sendJson(response,200,await hosted.cancel(decodeURIComponent(hostedAgent[1]!)));return true;}}

      if (path === "/v1/ponder/local" && ["GET","POST"].includes(request.method ?? "")) {
        sendJson(response,200,request.method === "POST" ? await deps.localPonder.configure(await readJson(request)) : requestUrl.searchParams.get("catalog") === "0" ? await deps.localPonder.readSnapshot() : await deps.localPonder.read()); return true;
      }
      if (path === "/v1/ponder/local/agents" && request.method === "GET") {
        sendJson(response,200,await deps.localPonder.agents()); return true;
      }
      const localControl = /^\/v1\/ponder\/local\/agents\/([^/]+)\/control$/.exec(path);
      if (localControl && request.method === "POST") {
        sendJson(response,200,await deps.localPonder.control(decodeURIComponent(localControl[1]!),await readJson(request))); return true;
      }
    } catch(error) {
      if(error instanceof ZodError) {sendJson(response,422,{error:"local_ponder_invalid_request"});return true;}
      if(error instanceof Error && error.message.startsWith("local_ponder_")) {
        sendJson(response,error.message.endsWith("_not_found") ? 404 : error.message.endsWith("_unavailable") ? 422 : 409,{error:error.message});return true;
      }
      throw error;
    }
  }
  if (path === "/v1/ponder/desktop/projects" && request.method === "GET") {
    sendJson(response, 200, await deps.ponderDesktopProjectsPayload(requestUrl.searchParams.get("after")));
    return true;
  }
  if (path === "/v1/ponder/desktop/share-project" && request.method === "POST") {
    sendJson(response, 200, await deps.ponderDesktopShareProjectPayload(await readJson(request)));
    return true;
  }
  const handoffEditContext = /^\/v1\/ponder\/handoffs\/([a-zA-Z0-9%:_-]+)\/edit$/.exec(path);
  if (handoffEditContext && request.method === "GET") {
    sendJson(response, 200, await deps.ponderRequestPayload({
      path: `/ponder/handoffs/${encodeURIComponent(decodeURIComponent(handoffEditContext[1]!))}/edit${requestUrl.search}`, method: "GET" }));
    return true;
  }
  if (path === "/v1/ponder/desktop/outputs" && request.method === "POST") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: "/ponder/desktop/outputs", method: "POST",
      body: await readJson(request) as Record<string, unknown> }));
    return true;
  }
  if (path === "/v1/ponder/desktop/attach-session" && request.method === "POST") {
    sendJson(response, 200, await deps.ponderDesktopAttachSessionPayload(await readJson(request)));
    return true;
  }
  if (path === "/v1/ponder/desktop" && request.method === "GET") {
    sendJson(response, 200, await deps.ponderDesktopConnectionPayload("status"));
    return true;
  }
  if ((path === "/v1/ponder/desktop/link" || path === "/v1/ponder/desktop/unlink") && request.method === "POST") {
    sendJson(response, 200, await deps.ponderDesktopConnectionPayload(path.endsWith("/unlink") ? "unlink" : "link"));
    return true;
  }
  if (["/v1/ponder/settings", "/v1/ponder/activity"].includes(path) && ["GET", "POST"].includes(request.method ?? "")) {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: path.slice(3) + requestUrl.search,
      method: request.method as "GET" | "POST", ...(request.method === "POST" ? { body: await readJson(request) as Record<string, unknown> } : {}) }));
    return true;
  }
  if (["/v1/ponder/recommendations", "/v1/ponder/notifications"].includes(path) && request.method === "GET") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: path.slice(3) + requestUrl.search, method: "GET" }));
    return true;
  }
  const recommendationAction = /^\/v1\/ponder\/recommendations\/([a-zA-Z0-9_-]+)\/action$/.exec(path);
  const notificationRead = /^\/v1\/ponder\/notifications\/([a-zA-Z0-9_-]+)\/read$/.exec(path);
  if ((recommendationAction || notificationRead) && request.method === "POST") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: path.slice(3), method: "POST", body: await readJson(request, { maxBytes: 128 * 1024 }) as Record<string, unknown> }));
    return true;
  }
  if (path === "/v1/ponder" && request.method === "POST") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: "/ponder", method: "POST" }));
    return true;
  }
  if (path === "/v1/ponder/work" && request.method === "GET") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: "/ponder/work" }));
    return true;
  }
  if (["/v1/ponder/handoffs/cancel", "/v1/ponder/handoffs/edit"].includes(path) && request.method === "POST") {
    const key = request.headers["idempotency-key"];
    sendJson(response, 200, await deps.ponderRequestPayload({ path: path.slice(3), method: "POST",
      body: await readJson(request) as Record<string, unknown>, idempotencyKey: typeof key === "string" ? key : undefined }));
    return true;
  }
  if (path === "/v1/ponder/results/retry" && request.method === "POST") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: "/ponder/results/retry",
      method: "POST", body: await readJson(request) as Record<string, unknown> }));
    return true;
  }
  if (path === "/v1/ponder/introduction/seen" && request.method === "POST") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: "/ponder/introduction/seen", method: "POST", body: await readJson(request) as Record<string, unknown> }));
    return true;
  }
  if (path === "/v1/ponder/work-inputs" && request.method === "POST") {
    sendJson(response, 201, await deps.ponderRequestPayload({ path: "/work-inputs", method: "POST", body: await readJson(request) as Record<string, unknown> }));
    return true;
  }
  const finalizeInputMatch = /^\/v1\/ponder\/work-inputs\/([a-zA-Z0-9_-]+)\/finalize$/.exec(path);
  if (finalizeInputMatch && request.method === "POST") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: `/work-inputs/${encodeURIComponent(finalizeInputMatch[1]!)}/finalize`, method: "POST" }));
    return true;
  }
  const outputMatch = /^\/v1\/ponder\/work-outputs\/([a-zA-Z0-9_-]+)$/.exec(path);
  if (outputMatch && request.method === "GET") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: `/work-outputs/${encodeURIComponent(outputMatch[1]!)}` }));
    return true;
  }
  const conversationMatch = /^\/v1\/ponder\/conversations\/([a-zA-Z0-9_-]+)$/.exec(path);
  if (conversationMatch && request.method === "GET") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: `/conversations/${encodeURIComponent(conversationMatch[1]!)}` }));
    return true;
  }
  const activityMatch = /^\/v1\/ponder\/conversations\/([a-zA-Z0-9_-]+)\/activity$/.exec(path);
  if (activityMatch && request.method === "GET") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: `/conversations/${encodeURIComponent(activityMatch[1]!)}/activity${requestUrl.search}` }));
    return true;
  }
  const turnMatch = /^\/v1\/ponder\/conversations\/([a-zA-Z0-9_-]+)\/turns$/.exec(path);
  if (turnMatch && request.method === "POST") {
    const idempotencyKey = request.headers["idempotency-key"];
    sendJson(response, 201, await deps.ponderRequestPayload({ path: `/conversations/${encodeURIComponent(turnMatch[1]!)}/turns`, method: "POST", body: await readJson(request) as Record<string, unknown>, idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : undefined }));
    return true;
  }
  const eventsMatch = /^\/v1\/ponder\/turns\/([a-zA-Z0-9_-]+)\/events$/.exec(path);
  if (eventsMatch && request.method === "GET") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: `/turns/${encodeURIComponent(eventsMatch[1]!)}\/events${requestUrl.search}` }));
    return true;
  }
  const cancelMatch = /^\/v1\/ponder\/turns\/([a-zA-Z0-9_-]+)\/cancel$/.exec(path);
  if (cancelMatch && request.method === "POST") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: `/turns/${encodeURIComponent(cancelMatch[1]!)}/cancel`, method: "POST" }));
    return true;
  }
  const waitMatch = /^\/v1\/ponder\/turns\/([a-zA-Z0-9_-]+)\/waits\/([a-zA-Z0-9_-]+)\/resolve$/.exec(path);
  if (waitMatch && request.method === "POST") {
    sendJson(response, 200, await deps.ponderRequestPayload({ path: `/turns/${encodeURIComponent(waitMatch[1]!)}/waits/${encodeURIComponent(waitMatch[2]!)}/resolve`, method: "POST", body: await readJson(request) as Record<string, unknown> }));
    return true;
  }
  return false;
}
