import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";

/** Only credentials in the active Desktop account reach the hosted read API. */
export async function readHostedExecutionActivity(access: {apiBaseUrl:string;token:string}, teamId:string, projectId:string|null):Promise<unknown> {
  const query = new URLSearchParams(projectId ? { projectId } : {});
  const headers = hostedApiAuthHeaders(access.token);
  headers.set("x-openpond-team-id", teamId);
  const response = await fetch(`${access.apiBaseUrl.replace(/\/+$/, "")}/v1/training/activity?${query}`, {
    headers, redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Execution activity is unavailable (${response.status}).`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Execution activity returned no body.");
  const chunks:Uint8Array[]=[]; let size=0;
  try { for (;;) { const chunk=await reader.read(); if(chunk.done)break; size+=chunk.value.byteLength;
    if(size>524_288)throw new Error("Execution activity exceeded its bounded response."); chunks.push(chunk.value); }
  } finally { await reader.cancel();reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
