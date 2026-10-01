import {contentHash} from "@openpond/harness";
import { z } from "zod";
import { HumanReviewTransportSchema,HumanInspectionSchema,HumanEvidenceSchema,HumanFormSchema,HumanResultViewSchema, HumanReviewViewSchema, HumanInboxSchema, type HumanReviewCommand, type HumanReviewRequest, type HumanReviewTransportRequest } from "@openpond/evals/human-review";
export class HumanReviewClientError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "HumanReviewClientError"; } }
export class OpenPondHumanReviewClient {
  readonly options: { baseUrl: string; apiKey: string; scope: string; fetch?: typeof globalThis.fetch };
  constructor(options: OpenPondHumanReviewClient["options"]) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search || !options.apiKey.trim() || !options.scope.trim() || options.scope !== options.scope.trim() || /[\r\n]/.test(options.scope)) throw new Error("Use a scoped key and a plain HTTP(S) API endpoint.");
    this.options = { ...options, baseUrl: url.toString().replace(/\/+$/, "") };
  }
  async command(command: HumanReviewCommand, signal?: AbortSignal) {
    const result = HumanReviewViewSchema.parse(await this.request({ endpoint: "command", scope: this.options.scope, command }, signal));
    const revisionMatches = command.action === "cancel"
      ? result.status === "cancelled" && result.revision >= command.expectedRevision + 1
      : result.revision === command.expectedRevision + 1;
    if (result.id !== command.id || result.scope !== this.options.scope || !revisionMatches) throw new HumanReviewClientError(502, "human_response_identity_mismatch", "Review response differs from the submitted operation.");
    return result;
  }
  async get(id: string, revision?: number, signal?: AbortSignal) {
    const result = HumanReviewViewSchema.parse(await this.request({ endpoint: "get", scope: this.options.scope, id, ...(revision ? { revision } : {}) }, signal));
    if (result.id !== id || result.scope !== this.options.scope || revision !== undefined && result.revision !== revision) throw new HumanReviewClientError(502, "human_response_identity_mismatch", "Review response differs from the requested identity.");
    return result;
  }
  async inbox(query: Omit<Extract<HumanReviewRequest, { endpoint: "inbox" }>, "endpoint" | "scope">, signal?: AbortSignal) {
    const result = HumanInboxSchema.parse(await this.request({ ...query, endpoint: "inbox", scope: this.options.scope }, signal));
    if (result.items.some(r => r.scope !== this.options.scope || query.projectId && r.projectId !== query.projectId)) throw new HumanReviewClientError(502, "human_inbox_scope_mismatch", "Inbox response differs from the authorized scope.");
    return result;
  }
  async snapshot(input:Omit<Extract<HumanReviewTransportRequest,{endpoint:"snapshot"}>,"endpoint"|"scope">,signal?:AbortSignal) {return z.object({evidence:HumanEvidenceSchema,form:HumanFormSchema}).strict().parse(await this.request({...input,endpoint:"snapshot",scope:this.options.scope},signal));}
  async taskSnapshot(input:Omit<Extract<HumanReviewTransportRequest,{endpoint:"snapshot_tasks"}>,"endpoint"|"scope">,signal?:AbortSignal) {return z.object({evidence:HumanEvidenceSchema,form:HumanFormSchema}).strict().parse(await this.request({...input,endpoint:"snapshot_tasks",scope:this.options.scope},signal));}
  async inspect(id:string,signal?:AbortSignal,options?:{slot?:number;afterId?:string}) {const result=HumanInspectionSchema.parse(await this.request({endpoint:"inspect",scope:this.options.scope,id,...options},signal));if(result.some(row=>row.reviewId!==id))throw new HumanReviewClientError(502,"human_inspection_identity_mismatch","Inspection differs from selected review.");return result;}
  async results(executionId:string,selection?:Extract<HumanReviewTransportRequest,{endpoint:"results"}>["selection"],signal?:AbortSignal) {
    return HumanResultViewSchema.parse(await this.request({endpoint:"results",scope:this.options.scope,executionId,...(selection?{selection}:{})},signal));
  }
  async members(signal?:AbortSignal) {return z.array(z.object({userId:z.string(),name:z.string().nullable(),email:z.string().nullable(),role:z.string()}).strict()).parse(await this.request({endpoint:"members",scope:this.options.scope},signal));}
  async request(raw: HumanReviewTransportRequest, signal?: AbortSignal) {
    const body = HumanReviewTransportSchema.parse(raw);
    if(body.scope!==this.options.scope)throw new HumanReviewClientError(403,"human_scope_denied","Request differs from the scoped client workspace.");
    const serialized=JSON.stringify(body);if(new TextEncoder().encode(serialized).byteLength>1048576)throw new HumanReviewClientError(422,"human_request_too_large","Review request exceeds its bounded transport.");
    const response = await (this.options.fetch ?? globalThis.fetch)(`${this.options.baseUrl}/v1/human-review`, { method: "POST", headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json", "x-openpond-team-id": this.options.scope }, body: serialized, signal,redirect:"error" });
    const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
    if(reader){try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>8388608){await reader.cancel();throw new HumanReviewClientError(502,"human_response_too_large","Review response exceeds its bounded transport.");}chunks.push(part.value);}}finally{reader.releaseLock();}}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    let data:unknown;try{data=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{throw new HumanReviewClientError(502,"human_response_invalid","Review response is not valid JSON.");}
    if (!response.ok) { const failure = z.object({ code: z.string().optional(), error: z.string().optional() }).passthrough().safeParse(data); throw new HumanReviewClientError(response.status, failure.success ? failure.data.code ?? "human_request_failed" : "human_request_failed", failure.success ? failure.data.error ?? "Review request failed." : "Review request failed."); }
    if(body.endpoint==="results"){
      const result=HumanResultViewSchema.parse(data),{contentHash:hash,...content}=result;
      if(result.executionId!==body.executionId||contentHash(content)!==hash||body.selection!==undefined&&contentHash(result.selection)!==contentHash(body.selection))throw new HumanReviewClientError(502,"human_result_identity_mismatch","Human results differ from the exact retained execution or selected reviews.");
    }
    if(body.endpoint==="snapshot"||body.endpoint==="publish_evidence"){const result=z.object({evidence:HumanEvidenceSchema,form:HumanFormSchema}).strict().parse(data);if(result.evidence.graderBinding.id!==body.graderId||result.evidence.attempts.length!==body.selections.length||result.evidence.attempts.some((a,i)=>a.experimentId!==body.selections[i]!.executionId||a.attemptId!==body.selections[i]!.receiptId))throw new HumanReviewClientError(502,"human_snapshot_identity_mismatch","Review snapshot differs from selected retained evidence.");}
    if(body.endpoint==="publish_local"){const result=z.object({evidence:HumanEvidenceSchema,form:HumanFormSchema}).strict().parse(data);if(!result.evidence.publication||result.evidence.attempts.length!==body.evidence.attempts.length||result.evidence.attempts.some((attempt,index)=>attempt.localSource?.kind!=="owner_attested_local"||attempt.experimentId!==body.evidence.attempts[index]!.executionId||attempt.attemptId!==body.evidence.attempts[index]!.receiptId||attempt.localSource.retainedAttemptHash!==body.evidence.attempts[index]!.origin.retainedAttemptHash))throw new HumanReviewClientError(502,"human_publication_identity_mismatch","Published review differs from the exact local-origin export.");}
    if(body.endpoint==="snapshot_tasks"){const result=z.object({evidence:HumanEvidenceSchema,form:HumanFormSchema}).strict().parse(data);if(result.evidence.graderBinding.id!==body.graderId||contentHash(result.evidence.dataset)!==contentHash(body.dataset)||(body.taskIds!==undefined&&contentHash(result.evidence.taskIds)!==contentHash(body.taskIds)||!result.evidence.taskIds?.length||new Set(result.evidence.taskIds).size!==result.evidence.taskIds.length))throw new HumanReviewClientError(502,"human_snapshot_identity_mismatch","Task snapshot differs from the selected exact tasks.");}
    return data;
  }
}
