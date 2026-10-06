import { requestOpenPondPublicApi } from "./sandboxes.js";

/** The local desktop server keeps the account credential out of the renderer. */
export async function requestHostedPonder(input: {
  path: string;
  teamId?: string;
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<Record<string, unknown>> {
  return requestOpenPondPublicApi(input);
}
