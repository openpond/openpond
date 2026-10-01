import { HumanInboxSchema, HumanReviewViewSchema, HumanReviewTransportSchema, HumanInspectionSchema, type HumanReviewTransportRequest } from "@openpond/evals/human-review";
import { apiFetch, type ClientConnection } from "../../api/api-client";
export type HumanInboxLocation = "local" | "hosted";
export type HumanInboxContext = { connection: ClientConnection; scope: string; actorId: string; location: HumanInboxLocation };
export async function humanRequest(context: HumanInboxContext, raw: HumanReviewTransportRequest, signal?: AbortSignal) {
  if (raw.scope !== context.scope) throw new Error("Review workspace changed. Reload the assignment.");
  return apiFetch<unknown>(context.connection, `/v1/human-review?location=${context.location}`, { method: "POST", body: JSON.stringify(HumanReviewTransportSchema.parse(raw)), signal });
}
function view(raw: unknown, context: HumanInboxContext, id: string) {
  const record=HumanReviewViewSchema.parse(raw);
  if(record.scope!==context.scope||record.id!==id)throw new Error("Review response identity differs from the requested assignment.");
  return record;
}
export const humanApi = {
  inbox: async (context: HumanInboxContext, input: Omit<Extract<HumanReviewTransportRequest, {endpoint:"inbox"}>, "endpoint"|"scope">, signal?: AbortSignal) => checkedInbox(await humanRequest(context, {...input, endpoint:"inbox",scope:context.scope},signal),context),
  get: async (context: HumanInboxContext,id:string,signal?:AbortSignal) => view(await humanRequest(context,{endpoint:"get",scope:context.scope,id},signal),context,id),
  inspect: async(context:HumanInboxContext,id:string,slot?:number,afterId?:string,signal?:AbortSignal) => checkedInspection(await humanRequest(context,{endpoint:"inspect",scope:context.scope,id,...(slot===undefined?{}:{slot}),...(afterId?{afterId}:{})},signal),id),
  command: async(context:HumanInboxContext,command:Extract<HumanReviewTransportRequest,{endpoint:"command"}>["command"]) => view(await humanRequest(context,{endpoint:"command",scope:context.scope,command}),context,command.id),
};

function checkedInbox(raw:unknown,context:HumanInboxContext){const page=HumanInboxSchema.parse(raw);if(page.items.some(row=>row.scope!==context.scope))throw new Error("Inbox response belongs to another workspace.");return page;}
function checkedInspection(raw:unknown,id:string){const rows=HumanInspectionSchema.parse(raw);if(rows.some(row=>row.reviewId!==id))throw new Error("Evidence response belongs to another assignment.");return rows;}
