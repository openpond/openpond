import { z } from "zod";
import { requestOpenPondPublicApi } from "./sandboxes.js";

const requestSchema = z.object({
  teamId: z.string().trim().min(1).max(240),
  resource: z.enum(["options", "policies", "definitions", "serving-targets"]),
  method: z.enum(["GET", "POST"]),
  body: z.record(z.string(), z.unknown()).optional(),
}).strict();

/** Uses the account credential and the canonical hosted policy API. No run endpoint. */
export async function requestConversationLearning(raw: unknown): Promise<unknown> {
  const request = requestSchema.parse(raw);
  if (request.method === "POST" && request.resource === "options") throw new Error("Learning options are read-only.");
  const options = requestOpenPondPublicApi({
    teamId: request.teamId,
    path: `/connected-evidence/learning/${request.resource}`,
    method: request.method,
    ...(request.method === "POST" ? { body: request.body ?? {} } : {}),
  });
  if (request.method === "GET" && request.resource === "options") {
    const [payload, ponder] = await Promise.all([options, requestOpenPondPublicApi({ teamId: request.teamId, path: "/ponder/settings", method: "GET" })]);
    return { ...payload, ponderBindingId: ponder.bindingId };
  }
  return options;
}
