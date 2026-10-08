import { createCapturedOpenPondPublicApiClient } from "./sandboxes.js";
import { loadOpenPondAccountContext } from "@openpond/runtime";

/** The local desktop server keeps the account credential out of the renderer. */
export async function requestHostedPonder(input: {
  path: string;
  teamId?: string;
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<Record<string, unknown>> {
  const { teamId, ...request } = input;
  const context = await loadOpenPondAccountContext();
  return createCapturedOpenPondPublicApiClient(context, teamId).request(request);
}
