import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleOrganizationRoutes({
  deps,
  request,
  requestUrl,
  response,
}: HttpRouteContext): Promise<boolean> {
  const { organizationPayload } = deps;
  if (requestUrl.pathname === "/v1/team-invitations") {
    if (request.method === "GET") {
      sendJson(response, 200, await organizationPayload({ type: "invitations_list" }));
      return true;
    }
  }
  const invitationDecision = /^\/v1\/team-invitations\/(accept|decline)$/.exec(requestUrl.pathname);
  if (invitationDecision && request.method === "POST") {
    sendJson(
      response,
      200,
      await organizationPayload({
        type: invitationDecision[1] === "accept" ? "invitation_accept" : "invitation_decline",
        payload: await readJson(request),
      })
    );
    return true;
  }
  if (requestUrl.pathname === "/v1/organizations") {
    if (request.method === "GET") {
      sendJson(response, 200, await organizationPayload({ type: "list" }));
      return true;
    }
    if (request.method === "POST") {
      sendJson(response, 201, await organizationPayload({ type: "create", payload: await readJson(request) }));
      return true;
    }
  }
  const organizationMatch = /^\/v1\/organizations\/([^/]+)(?:\/(.*))?$/.exec(requestUrl.pathname);
  if (organizationMatch) {
    const slug = decodeURIComponent(organizationMatch[1]!);
    const rest = organizationMatch[2] ?? "";
    if (!rest) {
      if (request.method === "GET") {
        sendJson(response, 200, await organizationPayload({ type: "get", slug }));
        return true;
      }
      if (request.method === "PATCH") {
        sendJson(
          response,
          200,
          await organizationPayload({
            type: "update",
            slug,
            payload: await readJson(request),
          })
        );
        return true;
      }
    }
    if (rest === "mcp-server") {
      if (request.method === "GET") {
        sendJson(response, 200, await organizationPayload({ type: "mcp_get", slug }));
        return true;
      }
      if (request.method === "POST") {
        sendJson(
          response,
          200,
          await organizationPayload({
            type: "mcp_generate",
            slug,
            payload: await readJson(request),
          })
        );
        return true;
      }
    }
    if (rest === "members") {
      if (request.method === "GET") {
        sendJson(response, 200, await organizationPayload({ type: "members", slug }));
        return true;
      }
      if (request.method === "POST") {
        sendJson(
          response,
          200,
          await organizationPayload({
            type: "member_upsert",
            slug,
            payload: await readJson(request),
          })
        );
        return true;
      }
    }
    if (rest === "mcp-server/rotate" && request.method === "POST") {
      sendJson(response, 200, await organizationPayload({ type: "mcp_rotate", slug }));
      return true;
    }
    if (rest === "mcp-server/disable" && request.method === "POST") {
      sendJson(response, 200, await organizationPayload({ type: "mcp_disable", slug }));
      return true;
    }
    if (rest === "mcp-server/enable" && request.method === "POST") {
      sendJson(response, 200, await organizationPayload({ type: "mcp_enable", slug }));
      return true;
    }
  }
  return false;
}
