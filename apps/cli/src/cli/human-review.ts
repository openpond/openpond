import {readFile,stat} from "node:fs/promises";
import {contentHash} from "@openpond/harness";
import {HumanReviewTransportSchema,HumanReviewViewSchema,HumanInboxSchema,HumanInspectionSchema,HumanResultViewSchema,type HumanReviewTransportRequest} from "@openpond/evals/human-review";
import {OpenPondHumanReviewClient} from "openpond-sdk/human-review";
import {loadConfig} from "../config";
import {DEFAULT_OPENPOND_API_BASE_URL} from "../urls";
import {ensureApiKey,optionString,resolveApiBaseUrlOption,resolveBaseUrl} from "./common";
import {createLocalAuthenticatedRequest,DEFAULT_LOCAL_TRAINING_API_URL} from "./training";
export async function runHumanReviewCommand(options:Record<string,string|boolean>,rest:string[]){
 const [action,id]=rest,scope=optionString(options,"team"),local=options.local===true||options.local==="true";
 if(!scope||!action||rest.length>2)throw new Error("usage: human-review <read|inbox|inspect|results|request> [id] --team <id> [--input-file <path>] [--local --server-url <loopback-origin>]");
 let body:HumanReviewTransportRequest;
 if(action==="request"){
  const file=optionString(options,"inputFile");if(id||!file||(await stat(file)).size>1048576)throw new Error("Request requires a bounded --input-file with exact scoped pins, revision and stable operationId for mutations.");
  body=HumanReviewTransportSchema.parse(JSON.parse(await readFile(file,"utf8")));if(body.scope!==scope)throw new Error("Input belongs to another workspace.");
 }else if(action==="inbox"){
  if(id)throw new Error("Inbox does not accept an assignment id.");
  body=HumanReviewTransportSchema.parse({endpoint:"inbox",scope,view:optionString(options,"view")||"mine",status:optionString(options,"status")||"active",limit:Number(optionString(options,"limit")||100),...(optionString(options,"project")?{projectId:optionString(options,"project")} : {}),...(optionString(options,"afterId")?{afterId:optionString(options,"afterId")} : {})});
 }else{
  if(!id)throw new Error(`${action} requires an exact assignment or execution id.`);
  body=HumanReviewTransportSchema.parse(action==="read"?{endpoint:"get",scope,id,...(optionString(options,"revision")?{revision:Number(optionString(options,"revision"))}:{} )}:action==="inspect"?{endpoint:"inspect",scope,id,...(optionString(options,"slot")?{slot:Number(optionString(options,"slot"))}:{}),...(optionString(options,"afterId")?{afterId:optionString(options,"afterId")}:{} )}:action==="results"?{endpoint:"results",scope,executionId:id}:{endpoint:action,scope,id});
 }
 let result:unknown;
 if(local){
  const base=new URL(optionString(options,"serverUrl")||DEFAULT_LOCAL_TRAINING_API_URL);if(base.protocol!=="http:"||!["localhost","127.0.0.1","[::1]"].includes(base.hostname)||base.username||base.password||base.search||base.hash||base.pathname!=="/")throw new Error("Local Human review requires an HTTP loopback server origin.");
  const request=await createLocalAuthenticatedRequest(base.origin),response=await request(new URL("/v1/human-review?location=local",base),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),redirect:"error",signal:AbortSignal.timeout(30000)});
  const text=await boundedResponse(response);result=JSON.parse(text);if(!response.ok)throw new Error(typeof (result as {error?:unknown}).error==="string"?(result as {error:string}).error:`Local Human request failed (${response.status}).`);
 }else{const config=await loadConfig(),client=new OpenPondHumanReviewClient({scope,apiKey:await ensureApiKey(config,resolveBaseUrl(config)),baseUrl:resolveApiBaseUrlOption(options)??config.apiBaseUrl??DEFAULT_OPENPOND_API_BASE_URL});result=await client.request(body,AbortSignal.timeout(30000));}
 if(body.endpoint==="get"||body.endpoint==="command"){const view=HumanReviewViewSchema.parse(result),expected=body.endpoint==="get"?body.id:body.command.id;if(view.id!==expected||view.scope!==scope)throw new Error("Review response differs from the requested identity.");}
 if(body.endpoint==="inbox"){const page=HumanInboxSchema.parse(result);if(page.items.some(record=>record.scope!==scope||body.projectId&&record.projectId!==body.projectId))throw new Error("Inbox response differs from the requested scope.");}
 if(body.endpoint==="inspect"&&HumanInspectionSchema.parse(result).some(row=>row.reviewId!==body.id))throw new Error("Inspection response differs from the selected assignment.");
 if(body.endpoint==="results"){const view=HumanResultViewSchema.parse(result),{contentHash:hash,...content}=view;if(view.executionId!==body.executionId||contentHash(content)!==hash||body.selection!==undefined&&contentHash(view.selection)!==contentHash(body.selection))throw new Error("Result response differs from the selected execution or retained review revisions.");}
 console.log(JSON.stringify(result,null,2));
}
async function boundedResponse(response:Response){const reader=response.body?.getReader();if(!reader)throw new Error("Review response is unavailable.");const chunks:Uint8Array[]=[];let size=0;try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>8388608)throw new Error("Review response exceeds its bounded transport.");chunks.push(part.value);}}finally{await reader.cancel();reader.releaseLock();}return Buffer.concat(chunks).toString("utf8");}
