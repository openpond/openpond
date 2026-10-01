import {candidateAuthoringToolNames} from "./experiment-candidate-tool-catalog.js";
import path from "node:path";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { inspectImagePixels } from "../openpond/local-image-tool-registry.js";
import { contentHash } from "@openpond/harness";
import type { OpenPondProfileState, OpenPondProfileRef, WorkspaceToolResult } from "@openpond/contracts";
import type { HarnessStateStore } from "../store/harness-state-store.js";
import type { ModelToolExecutionContext } from "../openpond/model-tool-registry.js";
import type { OpenPondCommandExecutionInput, OpenPondCommandRunResult } from "../openpond/command-access.js";
import type { CandidateAgentCommandInput } from "../openpond/authoring-tool-registry.js";
import type { WorkspaceToolExecutorDeps } from "../workspace-tools/workspace-tool-executor-types.js";
import type { LocalExperimentImprovementService } from "./experiment-improvement-service.js";
import { createCandidateCommandExecutor } from "./experiment-candidate-command.js";
import { candidateFileProgram } from "./experiment-candidate-file-program.js";
import { safeSegment } from "./local-harness-workspace-files.js";
const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;

/** Actual durable Work admission governs every tool. Model arguments and metadata copies cannot authorize a source. */
export function createExperimentCandidateTools(deps:{store:HarnessStateStore;improvements:LocalExperimentImprovementService;
  actorId():Promise<string>;teamId():Promise<string>;loadProfile(ref:OpenPondProfileRef):Promise<OpenPondProfileState>;
  /** A built, dependency-complete public runtime bundle staged by the server, never a live Profile. */
  agentRuntime?:{source:string;cliRelativePath:string};loadAgentRuntime?:()=>Promise<{source:string;cliRelativePath:string}>;operationSignal?:AbortSignal;bwrapPath?:string}) {
  async function authority(sessionId:string,turnId:string){
    const session=await deps.store.getSession(sessionId),turn=await deps.store.getTurn(turnId);
    if(!session||!turn||turn.sessionId!==sessionId)throw new Error("Candidate tool has no actual Work turn authority.");
    const marker=turn.metadata.refinementCandidate;
    if(turn.metadata.source!=="experiment-improvement"||!marker||typeof marker!=="object"||!("candidateId" in marker)||typeof marker.candidateId!=="string"){
      if(session.metadata?.source==="experiment-improvement"||session.metadata?.refinementCandidate!==undefined)throw new Error("This candidate Session requires a fresh private stored-turn admission before any continuation.");return null;
    }
    const actor={actorId:await deps.actorId(),teamId:await deps.teamId()},state=await deps.improvements.read(actor,marker.candidateId);
    if(state.status!=="authoring"||!state.work||state.work.sessionId!==sessionId||state.work.turnId!==turnId||turn.status!=="in_progress"||session.experience!=="work"
      ||contentHash(marker)!==contentHash({candidateId:state.id,authoringRevision:state.work.revision,...actor})||contentHash(session.currentProfile)!==contentHash(state.profileRef))throw new Error("Candidate tool binding changed or its Work turn has ended.");
    const partition=await deps.improvements.partition(actor,state.id);return{actor,state,partition};
  }
  let agentRuntime=deps.agentRuntime;
  const execute=createCandidateCommandExecutor({bwrapPath:deps.bwrapPath,authorize:async input=>{const value=await authority(input.sessionId,input.turnId);
    if(!value||value.state.id!==input.candidateId||value.state.revision!==input.expectedRevision)throw new Error("Candidate command changed before filesystem admission.");
    return{candidateId:value.state.id,candidateRevision:value.state.revision,ownerId:value.actor.actorId,sessionId:input.sessionId,turnId:input.turnId,sourceRoot:value.partition.sourceRoot,writablePaths:value.partition.writablePaths,
      ...(agentRuntime?{runtimeMounts:[{source:agentRuntime.source,destination:"/runtime/agent"},{source:path.join(agentRuntime.source,"node_modules"),destination:"/workspace/node_modules"}]}:{})};}});
  async function command(sessionId:string,turnId:string,command:string,options:{cwd?:string;timeoutMs?:number;maxOutputBytes?:number;signal?:AbortSignal;stdin?:string}={}){
    deps.operationSignal?.throwIfAborted();const value=await authority(sessionId,turnId);if(!value)throw new Error("This command is not admitted candidate Work.");
    const step=await deps.improvements.authoringStep(value.actor,value.state.id,value.state.revision);
    const cwd=options.cwd?.startsWith("/workspace/work/")?path.resolve(value.partition.sourceRoot,options.cwd.slice("/workspace/work/".length)):options.cwd==="/workspace/work"?value.partition.sourceRoot:options.cwd;
    return execute({candidateId:step.id,sessionId,turnId,expectedRevision:step.revision,command,...options,signal:options.signal&&deps.operationSignal?AbortSignal.any([options.signal,deps.operationSignal]):options.signal??deps.operationSignal,cwd});
  }
  return {
    async candidateAuthoringForTurn(sessionId:string,turnId:string){return (await authority(sessionId,turnId))!==null;},
    async authorizeCandidateTool(input:{sessionId:string;turnId:string;name:string}){const value=await authority(input.sessionId,input.turnId);if(!value)return false;if(!candidateAuthoringToolNames.has(input.name))throw new Error("This tool has no authority over isolated candidate Work.");return true;},
    async resolveCandidateProfile(context:ModelToolExecutionContext){const value=await authority(context.session.id,context.turnId);if(!value)throw new Error("Candidate Profile requires a trusted Work admission.");
      const base=await deps.loadProfile(value.state.profileRef),manifest=value.partition.publicManifest;
      const profile:OpenPondProfileState={...base,repoPath:value.partition.sourceRoot,sourcePath:value.partition.sourceRoot,
        skills:base.skills.filter(skill=>manifest.files.some(file=>file.kind==="skill"&&file.path===`skills/${safeSegment(skill.name)}/SKILL.md`)).map(skill=>({...skill,path:`skills/${safeSegment(skill.name)}/SKILL.md`,sourcePath:value.partition.sourceRoot})),
        agents:base.agents.filter(agent=>manifest.files.some(file=>file.kind==="agent"&&file.path.startsWith(`agents/${safeSegment(agent.id)}/`))).map(agent=>({...agent,path:manifest.files.find(file=>file.kind==="agent"&&file.path.startsWith(`agents/${safeSegment(agent.id)}/`))!.path})),evals:[],
        git:base.git?{...base.git,dirty:true,files:[]}:null};
      await authority(context.session.id,context.turnId);return profile;},
    async executeCandidateCommand(context:ModelToolExecutionContext,input:OpenPondCommandExecutionInput):Promise<OpenPondCommandRunResult>{const result=await command(context.session.id,context.turnId,input.command,{cwd:input.cwd??undefined,timeoutMs:(input.timeoutSeconds??120)*1000,signal:input.signal});
      return{ok:result.code===0&&!result.timedOut,command:input.command,cwd:input.cwd??context.session.cwd,exitCode:result.code,stdout:result.stdout,stderr:result.stderr,timedOut:result.timedOut,timeoutSeconds:Math.min(input.timeoutSeconds??120,180),truncated:result.stdoutTruncated||result.stderrTruncated,blockedReason:null};},
    async executeCandidateImage(context:ModelToolExecutionContext){
      const value=await authority(context.session.id,context.turnId);if(!value)throw new Error("Image inspection is not admitted candidate Work.");
      const requested=context.args.path;if(typeof requested!=="string"||!requested.trim())throw new Error("Select a candidate image path.");
      const absolute=requested.startsWith("/workspace/work/")?path.resolve(value.partition.sourceRoot,requested.slice("/workspace/work/".length)):path.resolve(value.partition.sourceRoot,requested);
      const relative=path.relative(value.partition.sourceRoot,absolute);if(!relative||relative.startsWith("..")||path.isAbsolute(relative))throw new Error("The image path escapes this candidate source.");
      const imagePath=`/workspace/work/${relative.split(path.sep).join("/")}`;
      const run=async(binary:string,args:string[],signal:AbortSignal)=>{const result=await command(context.session.id,context.turnId,[binary,...args].map(quote).join(" "),{signal,maxOutputBytes:750000,timeoutMs:30000});if(result.code!==0||result.timedOut||result.stdoutTruncated)throw new Error("The confined image decoder could not inspect this candidate image.");return result.stdout;};
      const inspection=await inspectImagePixels(imagePath,context.signal,run);
      const extension=({PNG:"png",JPEG:"jpg",GIF:"gif",WEBP:"webp",AVIF:"avif"} as Record<string,string>)[inspection.format];if(!extension)throw new Error("Select a PNG, JPEG, GIF, WebP or AVIF image.");
      // Read inside the same namespace. Never reopen an author-controlled symlink on the host.
      const encoded=await run("/runtime/node",["-e","const f=require('fs'),p=process.argv[1],b=f.readFileSync(p);if(b.length>500000)throw Error('Create a contact sheet under 500000 bytes for candidate inspection');process.stdout.write(b.toString('base64'))",imagePath],context.signal);
      if(!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)||encoded.length>670000)throw new Error("Candidate image bytes exceed the inspection boundary.");
      const previewRoot=await fs.mkdtemp(path.join(tmpdir(),"candidate-image-"));await fs.chmod(previewRoot,0o700);const previewPath=path.join(previewRoot,`preview.${extension}`),bytes=Buffer.from(encoded,"base64");await fs.writeFile(previewPath,bytes,{mode:0o400});
      await authority(context.session.id,context.turnId);
      const contentType=`image/${extension==="jpg"?"jpeg":extension}`,data={path:imagePath,contentType,sizeBytes:bytes.length,...inspection};
      return{toolCallId:context.callId,name:"view_image",ok:true,contentText:JSON.stringify({ok:true,action:"view_image",data}),data:{...data,openpondImagePreviewPath:previewPath}};
    },
    async executeCandidateAgentCommand(input:CandidateAgentCommandInput){const value=await authority(input.context.session.id,input.context.turnId);if(!value)throw new Error("Agent command is not admitted candidate Work.");agentRuntime??=await deps.loadAgentRuntime?.();if(!agentRuntime)throw new Error("The server has not staged a dependency-complete confined Agent runtime; build and install that public runtime before authoring Agent components.");
      const cli=agentRuntime.cliRelativePath;if(path.isAbsolute(cli)||cli.split(/[\\/]/).some(part=>!part||part===".."||part==="."))throw new Error("Agent runtime CLI binding is invalid.");
      const relative=path.relative(value.partition.sourceRoot,input.cwd);if(relative.startsWith("..")||path.isAbsolute(relative))throw new Error("Agent command source escapes its candidate.");
      const cwd=`/workspace/work${relative?`/${relative.split(path.sep).join("/")}`:""}`,args=input.command==="run"?[input.command,...input.args??[]]:[input.command,"--cwd",cwd,...input.args??[]];
      return command(input.context.session.id,input.context.turnId,`/runtime/node ${quote(`/runtime/agent/${cli}`)} ${args.map(quote).join(" ")}`,{cwd:input.cwd,timeoutMs:input.timeoutMs,maxOutputBytes:input.maxOutputBytes,signal:input.context.signal});},
    executeCandidateWorkspaceTool:(async input=>{if(!input.turnId){if(input.session.metadata?.source==="experiment-improvement"||input.session.metadata?.refinementCandidate!==undefined)throw new Error("Candidate files require a trusted actual turn.");return null;}
      const value=await authority(input.session.id,input.turnId);if(!value)return null;
      const supported=new Set(["list_files","read_files","search_files","workspace_status","preview_write_file","preview_write_files","preview_edit_file","preview_delete_file","write_file","write_files","edit_file","delete_file"]);
      if(!supported.has(input.request.action))throw new Error("Use the candidate file tools or confined exec_command/Agent tools; this operation has no authority over the live Profile.");
      const result=await command(input.session.id,input.turnId,`/runtime/node -e ${quote(candidateFileProgram)}`,{stdin:JSON.stringify({action:input.request.action,args:input.request.args,writablePaths:value.partition.writablePaths}),maxOutputBytes:800000});
      if(result.code!==0||result.timedOut||result.stdoutTruncated)throw new Error(result.stderr.slice(0,2000)||"Candidate source operation did not complete.");
      return{ok:true,action:input.request.action,output:"Completed in the isolated candidate source.",data:JSON.parse(result.stdout)} satisfies WorkspaceToolResult;
    }) satisfies NonNullable<WorkspaceToolExecutorDeps["executeCandidateWorkspaceTool"]>
  };
}
