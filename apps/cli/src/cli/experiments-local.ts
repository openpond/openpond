import { readFile,stat } from "node:fs/promises";
import { createLocalAuthenticatedRequest, DEFAULT_LOCAL_TRAINING_API_URL } from "./training";
import { printLocalExperimentResult } from "./experiments-local-output";
import { optionString,parseBooleanOption } from "./common";
import { LocalExperimentComparisonSchema, LocalExperimentRecordSchema } from "@openpond/contracts";
import { RunExperimentSchema } from "openpond-sdk/experiments";
import { compareExperiments } from "@openpond/evals/experiments";

/** --local selects the running local server, never a hosted Experiment client.
 * The existing capability loader keeps its token out of arguments and output. */
export async function runLocalExperimentsCommand(options:Record<string,string|boolean>,rest:string[]) {
  const [action,id,candidateId]=rest,teamId=optionString(options,"team");
  if(options.revision!==undefined)throw new Error("A local Experiment is one immutable run; read it by id rather than a saved configuration revision.");
  if(action!=="read"&&options.contentHash!==undefined)throw new Error("An exact configuration hash requires the local read action.");
  if(!action||rest.length>(action==="compare"?3:2))throw new Error("Local Experiments require an action; use --server-url for an existing local server.");
  const rawUrl=optionString(options,"serverUrl")||process.env.OPENPOND_LOCAL_API_URL||DEFAULT_LOCAL_TRAINING_API_URL;
  const base=new URL(rawUrl);
  if(base.protocol!=="http:"||!["localhost","127.0.0.1"].includes(base.hostname)||base.username||base.password||base.search||base.hash||base.pathname!=="/")
    throw new Error("Local Experiments require an HTTP loopback server origin.");
  const request=await createLocalAuthenticatedRequest(base.origin);
  async function command(action:string,payload:unknown):Promise<Record<string,unknown>> {
    const response=await request(new URL(teamId ? "/v1/local-experiments" : "/v1/chat-experiments",base),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...teamId ? {teamId} : {},action,payload})});
    const reply=await response.json() as Record<string,unknown>;
    if(!response.ok)throw new Error(typeof reply.error==="string"?reply.error:`Local Experiment request failed (${response.status}).`);
    return reply;
  }
  async function input() {
    const file=optionString(options,"inputFile");
    if(!file || !(await stat(file)).isFile() || (await stat(file)).size>67_108_864)throw new Error("Provide a bounded --input-file with exact local configuration and retained package bytes.");
    return JSON.parse(await readFile(file,"utf8")) as Record<string,unknown>;
  }
  let result:unknown;
  if(!teamId) {
    if(action === "models") result=await command("models",{});
    else if(action === "run" || action === "run-cloud") result=await command(action.replaceAll("-","_"),await input());
    else if(action === "list") result=await command("list",{});
    else if(action === "compare" && id && candidateId) result=await command("compare",{baselineId:id,candidateId});
    else if(action==="case" && id && optionString(options,"receiptId"))result=await command("case",{id,receiptId:optionString(options,"receiptId")});
    else if(id && ["read","status","cancel","result"].includes(action)) result=await command(action,{id});
    else throw new Error("Independent local Experiments support models/run/list/read/status/cancel/result/compare. Workspace operations require --team.");
    if(parseBooleanOption(options.json))console.log(JSON.stringify(result,null,2));else printLocalExperimentResult(result);return;
  }
  if(action==="prepare-harness") {
    if(id)throw new Error("Local Profile preparation accepts --input-file rather than an id.");
    result=await command("prepareHarness",await input());
  } else if(action==="run") {
    if(id)throw new Error("Local Run accepts reviewed configuration through --input-file rather than an id.");
    const value=await input();result=await command(value.package?"run":"runFromRelease",value);
  } else if(action==="list") {
    if(id)throw new Error("Local List does not accept an id.");
    const status=optionString(options,"status"),limit=optionString(options,"limit"),projectId=optionString(options,"project"),afterId=optionString(options,"afterId"),datasetHash=optionString(options,"datasetHash"),search=optionString(options,"search");
    result=await command("list",{...(status?{status}:{}),...(projectId?{projectId}:{}),...(datasetHash?{datasetHash}:{}),...(search?{search}:{}),...(afterId?{afterId}:{}),...(limit?{limit:Number(limit)}:{})});
  } else {
    if(!id)throw new Error(`${action} requires a local Experiment or scoring pass id.`);
    const afterId=optionString(options,"afterId"),limit=optionString(options,"limit");
    if(action==="duplicate") {
      const operationId=optionString(options,"operationId");
      if(!operationId)throw new Error("Duplicate requires --operation-id for safe replay.");
      const source=LocalExperimentRecordSchema.parse(await command("read",{id}));
      const configuration=RunExperimentSchema.parse({...source.configuration,operationId,request:{...source.configuration.request,operationId},sourceExperimentId:source.id});
      result=await command("runFromRelease",{configuration,expectedPackageHash:source.packageHash});
    } else if(action==="passes")result=await command("passes",{executionId:id,...(afterId?{afterId}:{}),...(limit?{limit:Number(limit)}:{})});
    else if(action==="case") {
      const receiptId=optionString(options,"receiptId"),sequence=optionString(options,"afterSequence");
      if(!receiptId)throw new Error("Local case inspection requires --receipt-id from the retained execution.");
      result=await command("case",{id,receiptId,...(sequence?{afterSequence:Number(sequence)}:{}),...(limit?{limit:Number(limit)}:{})});
    }
    else if(action==="score") {
      const value=await input(),execution=value.execution as Record<string,unknown>|undefined;
      if(execution?.id!==id)throw new Error("Local scoring input belongs to a different retained execution.");
      result=await command("score",value);
    } else if(action==="compare") {
      if(!candidateId)throw new Error("Local Compare requires baseline and candidate execution ids.");
      const evidence=LocalExperimentComparisonSchema.parse(await command("compare",{baselineId:id,candidateId}));
      result={...evidence,comparison:compareExperiments(evidence.baseline,evidence.candidate)};
    } else if(action==="read") {
      const configurationHash=optionString(options,"contentHash");
      result=await command("read",{id,...(configurationHash?{configurationHash}:{})});
    } else if(["status","cancel","result","pass"].includes(action))result=await command(action,{id});
    else if(action==="cancel-pass")result=await command("cancel",{id});
    else if(action==="pass-result")result=await command("result",{id});
    else throw new Error(`Local Experiment action is unavailable: ${action}`);
  }
  console.log(JSON.stringify(result,null,2));
}
