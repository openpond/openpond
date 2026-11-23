import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {homedir} from "node:os";
import {realpath} from "node:fs/promises";
import {z} from "zod";
import {contentHash} from "@openpond/harness";
import type {ClaudeCodeRuntime} from "openpond-sdk/experiments";
import {nativeAgentLaunch} from "../runtime/native-agents/config.js";
import {probeNativeAgent} from "../runtime/native-agents/setup.js";
import type {LocalInferenceState} from "./local-experiment-local-inference.js";
import {LocalExperimentError} from "./local-experiment-contract.js";

export type ClaudeProcessAuthentication =
 | {kind:"api_key";apiKey:string}
 | {kind:"subscription";environment:Record<string,string>};
type State=Awaited<ReturnType<LocalInferenceState>>;
type Model={id:string;displayName:string;outputLimit:number;contextWindow?:number};
function fail(message:string):never{throw new LocalExperimentError("claude_code_not_ready",message,422);}

/** Claude owns its subscription credentials. We inspect native login status and
 * pass only its credential namespace, never copy OAuth tokens or load history. */
export async function resolveClaudeExperimentAuthentication(current:State,executable:string){
 const config=current.settings.providers["claude-code"];
 if(config?.enabled){
  const launch=nativeAgentLaunch("claude-code",config);
  if(await realpath(launch.command)!==await realpath(executable))fail("The selected Claude executable differs from its native login runtime.");
  const environment:Record<string,string>={PATH:launch.env.PATH??"",HOME:launch.env.HOME??homedir()};
  for(const key of ["CLAUDE_CONFIG_DIR","CLAUDE_SECURESTORAGE_CONFIG_DIR","SystemRoot"])if(launch.env[key])environment[key]=launch.env[key]!;
  const options={env:environment,timeout:10000,maxBuffer:262144};
  const {stdout}=await promisify(execFile)(executable,["auth","status","--json"],options).catch(()=>fail("The local Claude subscription status is unavailable. Recheck the existing native login."));
  const status=z.object({loggedIn:z.literal(true),authMethod:z.literal("claude.ai"),email:z.string().min(1),orgId:z.string().nullable().optional(),subscriptionType:z.string().nullable().optional()}).passthrough().safeParse(JSON.parse(stdout));
  if(!status.success)fail("The selected Claude runtime must be signed into a Claude subscription; no API-key fallback is used for this native provider.");
  const help=(await promisify(execFile)(executable,["--help"],options)).stdout;
  for(const flag of ["--safe-mode","--setting-sources","--disable-slash-commands","--no-session-persistence","--system-prompt","--effort","--json-schema"])if(!help.includes(flag))fail("This Claude version cannot isolate a subscription-backed text experiment.");
  let models:Array<{id:string;displayName:string}>=current.settings.modelCaches["claude-code"]?.models??[];
  if(!models.some(model=>model.id.startsWith("claude-"))){
   const native=await probeNativeAgent("claude-code",config);
   if(native.status!=="ready"||!native.session?.models)fail(native.error??"Refresh the native Claude model catalog.");
   models=native.session.models.availableModels.map(m=>({id:m.modelId,displayName:m.name}));
  }
  // Native aliases can silently change their backing model. Admit only the
  // exact model IDs advertised by the installed native interface.
  const selected:Model[]=models.filter(m=>m.id.startsWith("claude-")).map(m=>({id:m.id,displayName:m.displayName,outputLimit:16384}));
  if(!selected.length)fail("The native Claude catalog has no exact model IDs for an experiment.");
  const authentication:NonNullable<ClaudeCodeRuntime["authentication"]>={kind:"subscription",accountHash:contentHash({authMethod:status.data.authMethod,email:status.data.email,orgId:status.data.orgId??null,subscriptionType:status.data.subscriptionType??null}),namespaceHash:contentHash({sourceHome:launch.sourceHome,configDirectory:environment.CLAUDE_CONFIG_DIR??null,secureStorageDirectory:environment.CLAUDE_SECURESTORAGE_CONFIG_DIR??null})};
  return{authentication,processAuthentication:{kind:"subscription",environment} as ClaudeProcessAuthentication,identity:authentication,models:selected};
 }
 const apiConfig=current.settings.providers.anthropic,secret=current.secrets.providers.anthropic;
 if(!apiConfig?.enabled||apiConfig.baseUrl&&new URL(apiConfig.baseUrl).origin!=="https://api.anthropic.com")fail("Enable the native Claude subscription provider or configure the direct Anthropic API-key provider.");
 const apiKey=secret?.source==="local_secret"?secret.value?.trim():secret?.source==="env"&&secret.envVar?process.env[secret.envVar]?.trim():undefined;
 if(!apiKey)fail("The selected Anthropic API-key provider is not connected.");
 const models:Model[]=(current.settings.modelCaches.anthropic?.models??[]).filter(m=>m.contextWindow&&m.outputLimit).map(m=>({id:m.id,displayName:m.displayName,outputLimit:m.outputLimit!,contextWindow:m.contextWindow!}));
 return{authentication:{kind:"api_key" as const},processAuthentication:{kind:"api_key",apiKey} as ClaudeProcessAuthentication,identity:{kind:"api_key",credentialId:secret!.credentialId,credentialRevision:secret!.revision??null},models};
}
