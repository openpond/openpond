import {z} from "zod";
import {fetchConnectedJson} from "./connected-evidence-http.js";
export type EvaluationCoordinationAccess={baseUrl:string;apiKey:string;actorId:string;teamId:string;projectId:string|null;fetch?:typeof fetch};
/** Bounded authenticated transport for the current evaluation owner. There is
 * no retry or operation allocation here; commands retain their reviewed IDs. */
export class EvaluationCoordinationTransport {
  readonly origin:string;
  constructor(readonly access:EvaluationCoordinationAccess){
    const url=new URL(access.baseUrl);
    if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash||!access.apiKey.trim()||!access.actorId.trim()||!access.teamId.trim())throw new Error("Select the current evaluation owner and HTTP API origin.");
    this.origin=url.toString().replace(/\/+$/,"");
  }
  async post(path:"experiment-evaluation-schedules"|"advanced-refiner-evaluations",request:unknown,signal?:AbortSignal){
    const body=JSON.stringify({teamId:this.access.teamId,projectId:this.access.projectId,request});
    if(new TextEncoder().encode(body).byteLength>1_048_576)throw new Error("The reviewed evaluation command exceeds 1 MiB.");
    const {response,value}=await fetchConnectedJson(this.access.fetch??fetch,`${this.origin}/v1/${path}`,{
      method:"POST",redirect:"error",headers:{Authorization:`Bearer ${this.access.apiKey}`,"X-OpenPond-Team-Id":this.access.teamId,"Content-Type":"application/json"},body,signal,
    },(status,code,message)=>Object.assign(new Error(message),{status,code}));
    if(!response.ok){const error=z.object({error:z.string().optional(),message:z.string().optional(),code:z.string().optional()}).passthrough().safeParse(value);throw Object.assign(new Error(error.success?error.data.error??error.data.message??"Evaluation operation failed.":"Evaluation operation failed."),{status:response.status,code:error.success?error.data.code:undefined});}
    return value;
  }
}
