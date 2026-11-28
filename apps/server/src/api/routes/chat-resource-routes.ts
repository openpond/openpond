import { ZodError } from "zod";
import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";
import { isDesktopLocalRequest } from "../local-human-authority.js";
export async function handleChatResourceRoutes({deps,request,requestUrl,response}:HttpRouteContext):Promise<boolean> {
  const kind = requestUrl.pathname === "/v1/local-datasets" ? "dataset" : requestUrl.pathname === "/v1/chat-experiments" ? "experiment" : null;
  if (!kind || request.method !== "POST") return false;
  response.setHeader("Cache-Control","no-store");
  if (!deps.chatResourcePayload) { sendJson(response,503,{error:"Local chat resources are unavailable."}); return true; }
  try {
    const body = await readJson(request,{maxBytes:67_108_864});
    if (kind === "experiment" && body && typeof body === "object" && "action" in body &&
      body.action === "local_adapter_benchmark" && !isDesktopLocalRequest(request)) {
      sendJson(response,403,{error:"Open the local desktop to review or run a saved adapter."});
      return true;
    }
    sendJson(response,200,await deps.chatResourcePayload(kind,body));
  }
  catch (error) { sendJson(response,error instanceof ZodError ? 400 : 409,{error:error instanceof ZodError ? "Invalid resource fields: "+error.issues.map(issue=>`${issue.path.join(".") || "request"}: ${issue.message}`).join("; ") : error instanceof Error ? error.message : "Resource operation failed."}); }
  return true;
}
