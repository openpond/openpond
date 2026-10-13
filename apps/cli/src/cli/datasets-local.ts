import { readFile, stat } from "node:fs/promises";
import { createLocalAuthenticatedRequest, DEFAULT_LOCAL_TRAINING_API_URL } from "./training";
import { optionString, parseBooleanOption } from "./common";

export async function runLocalDatasetsCommand(options:Record<string,string|boolean>,rest:string[]) {
  const [action,id] = rest;
  if (!action || rest.length > 2) throw new Error("Usage: datasets <context|select|select-model|select-destination|new-experiment|select-experiment|rename-experiment|schema|list|read|create|save|file|validate|check-graders|check-sources|package|import|inspect-source|import-source|list-graders|read-grader|save-grader|test-grader|upload|publish|sync|pause-sync|disconnect-sync|related-chats> [id] --local [--input-file <path>] [--operation-id <id>] [--expected-revision <n>] [--json]");
  const base = new URL(optionString(options,"serverUrl") || process.env.OPENPOND_LOCAL_API_URL || DEFAULT_LOCAL_TRAINING_API_URL);
  if (base.protocol !== "http:" || !["localhost","127.0.0.1","[::1]"].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("Local Datasets require an HTTP loopback server origin.");
  // Packaging returns both the bounded authored workspace and its sealed files.
  const request = await createLocalAuthenticatedRequest(base.origin,{maximumResponseBytes:Number.POSITIVE_INFINITY,timeoutMs:1_200_000});
  const file = optionString(options,"inputFile");
  let payload:unknown = {};
  if (file) {
    const info = await stat(file); if (!info.isFile() || info.size > 64*1024*1024) throw new Error("Provide a bounded regular input file.");
    payload = JSON.parse(await readFile(file,"utf8"));
  }
  const revision = optionString(options,"expectedRevision");
  const conversational:Record<string,unknown> | null = action === "context" ? {action:"context",payload}
    : action === "select-destination" ? {action:"set_destination",payload:{executionLocation:id === "hosted" ? "cloud" : id}}
    : action === "select-model" ? {action:"set_model",payload:{evaluationModel:id}}
    : action === "new-experiment" ? {action:"create_scope",payload:{operationId:optionString(options,"operationId")}}
    : action === "select" ? {action:"set_focus",payload:{kind:"dataset",id:id ?? null,...revision ? {revision:Number(revision)} : {}}}
    : action === "select-experiment" ? {action:"select_scope",payload:{scopeId:id}}
    : action === "rename-experiment" ? {action:"rename_scope",payload:{scopeId:id,...payload as object}}
    : null;
  if (conversational && !process.env.OPENPOND_CHAT_INVOCATION) throw new Error("Chat selection commands require the app's scoped command executor.");
  const response = await request(new URL("/v1/local-datasets",base),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...(conversational ?? {action:action.replaceAll("-","_"),...(id?{id}:{}),...(options.operationId?{operationId:optionString(options,"operationId")}:{}),...(revision?{expectedRevision:Number(revision)}:{}),payload}),...(process.env.OPENPOND_CHAT_INVOCATION ? {invocationToken:process.env.OPENPOND_CHAT_INVOCATION} : {})})});
  const result = await response.json() as Record<string,unknown>;
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Local Dataset request failed (${response.status}).`);
  if (parseBooleanOption(options.json)) { console.log(JSON.stringify(result,null,2)); return; }
  const summaries = Array.isArray(result) ? result : [...result.summary ? [result.summary] : [],...Array.isArray(result.summaries) ? result.summaries : []];
  if (!summaries.length) { console.log(JSON.stringify(result,null,2)); return; }
  for (const summary of summaries as {kind:string;graderId?:string;datasetId?:string;name:string;id:string;revision:number;state:string;taskCount:number;graderCount:number;checkState:string;syncState:string}[]) {
    if(summary.kind === "grader") {console.log(`${summary.name} · version ${summary.revision} · ${summary.state} · ${summary.checkState}`);console.log(`${summary.id} · Dataset ${summary.datasetId} · Grader ${summary.graderId}`);continue;}
    console.log(`${summary.name} · version ${summary.revision} · ${summary.state} · ${summary.syncState}`);
    console.log(`${summary.id} · ${summary.taskCount} tasks · ${summary.graderCount} graders · ${summary.checkState}`);
    console.log(`Inspect: openpond datasets read ${summary.id} --local --expected-revision ${summary.revision} --json`);
    console.log(`Check graders: openpond datasets check-graders ${summary.id} --local --expected-revision ${summary.revision}`);
  }
}
