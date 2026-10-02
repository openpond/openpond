import {HumanComparisonProjectionSchema,HumanComparisonSelectionsSchema,verifyHumanComparisonProjection} from "@openpond/evals/human-review";
import {HostedAdvancedOwnerRequestSchema,runHostedAdvancedRefinerOwner} from "../training/hosted-advanced-refiner-owner.js";
import {promises as fs} from "node:fs";
import path from "node:path";
import {z} from "zod";
import {SessionSchema,TurnSchema,WorkspaceToolRequestSchema,type Session,type Turn} from "@openpond/contracts";
import {contentHash,createHarnessSourcePackage} from "@openpond/harness";
import {inspectOpenPondProfileSource} from "@openpond/cloud";
import {verifyExperimentEvidence} from "@openpond/evals/experiments";
import {ExperimentImprovementCommandSchema} from "openpond-sdk/experiment-improvements";
import {SqliteStore} from "../store/store.js";
import {createLocalExperimentImprovementService,type ImprovementAdoptionReadback} from "./experiment-improvement-service.js";
import {createExperimentCandidateTools} from "./experiment-candidate-tools.js";
import {importProfileIntoLocalHarnessWorkspace,compileLocalHarnessSource,materializeLocalHarnessRelease} from "./local-harness-workspace-service.js";
import {profileOriginFilesHash} from "../evaluations/local-experiment-profile-origin-materialization.js";
import {compiledCandidateExecutableIdentity} from "./experiment-candidate-equivalence.js";
import {resolveContainedRegularFile} from "./local-harness-workspace-files.js";
import {sha256} from "@openpond/harness";
import {profileEvaluationsForRuntime} from "./local-profile-evaluation-runtime.js";
import {withRemoteProfileCandidateSnapshot} from "./experiment-profile-remote-freeze.js";
import {applyCandidateProfileSource,compileOriginalCandidateProfile} from "./experiment-profile-git-source.js";
import {createAuthoringModelToolDefinitions} from "../openpond/authoring-tool-registry.js";
import {exportHostedProfileCandidate} from "./experiment-profile-candidate-export.js";
import {createCandidateAgentRuntimeLoader} from "./candidate-agent-runtime.js";
import {createWorkAgentSdkArchiveLoader} from "../work/work-agent-sdk-archive.js";
import {candidateFileToolDefinitions} from "./experiment-candidate-tool-catalog.js";

/** These facts arrive exclusively over private worker IPC after current PG ACL
 * and actual hosted-turn admission. They are never browser capabilities. */
export const HostedImprovementOwnerInputSchema=z.object({
 actor:z.object({actorId:z.string().min(1),teamId:z.string().min(1)}).strict(),storeDir:z.string().min(1),
 source:z.object({repoPath:z.string().min(1),repositoryId:z.string().min(1),profileId:z.string().min(1),sourceRevision:z.string().regex(/^[a-f0-9]{40,64}$/),filesHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
 evidence:z.object({manifest:z.unknown(),result:z.unknown()}).strict(),operation:z.enum(["advanced","describe","command","queue","cancelQueued","bind","finish","beginTesting","cancelTesting","failTesting","comparison","beginAdoption","export","source","tool","toolCatalog"]),
 advanced:HostedAdvancedOwnerRequestSchema.optional(),command:ExperimentImprovementCommandSchema.optional(),candidateId:z.string().optional(),revision:z.number().int().positive().optional(),
 actualSession:SessionSchema.optional(),actualTurn:TurnSchema.optional(),recipe:z.unknown().optional(),baseline:z.object({manifest:z.unknown(),result:z.unknown()}).strict().optional(),candidate:z.object({manifest:z.unknown(),result:z.unknown()}).strict().optional(),
 humanProjection:HumanComparisonProjectionSchema.optional(),humanSelections:HumanComparisonSelectionsSchema.optional(),adoptionReadback:z.unknown().optional(),failure:z.object({message:z.string().max(2000),cancelled:z.boolean()}).strict().optional(),tool:z.object({name:z.string(),args:z.record(z.string(),z.unknown()),callId:z.string()}).strict().optional(),
 agentRuntime:z.object({source:z.string(),cliRelativePath:z.string()}).strict().optional(),
 queued:z.object({sessionId:z.string(),turnId:z.string(),createdAt:z.string().datetime()}).strict().optional(),
}).strict();

/** A real private compiler/store owner, independent of any desktop installation.
 * The worker serializes this namespace with its PG lease and keeps it on EFS.
 * Every invocation recompiles accepted source and checks immutable closure. */
export async function runHostedExperimentImprovementOwner(raw:unknown,signal:AbortSignal=new AbortController().signal){
 signal.throwIfAborted();const input=HostedImprovementOwnerInputSchema.parse(raw),{actor,source}=input;
 if(!path.isAbsolute(input.storeDir)||!path.isAbsolute(source.repoPath))throw new Error("Hosted candidate owner requires contained absolute private paths.");
 const evidence=verifyExperimentEvidence(input.evidence),additionalEvidence=[input.baseline,input.candidate].filter(value=>value!==undefined).map(value=>verifyExperimentEvidence(value));if(evidence.manifest.teamId!==actor.teamId)throw new Error("Hosted candidate evidence belongs to another team.");
 if(await profileOriginFilesHash(source.repoPath)!==source.filesHash)throw new Error("The admitted hosted Profile source bytes changed.");
 const workspaceId=`hosted-improve-source-${contentHash([actor,source.repositoryId,source.profileId,source.sourceRevision]).slice(0,40)}`,
  cache=path.join(input.storeDir,"library","profile-experiment-origins",workspaceId);
 await fs.mkdir(path.dirname(cache),{recursive:true,mode:0o700});
 if(!await fs.stat(cache).catch(()=>null))await fs.cp(source.repoPath,cache,{recursive:true,errorOnExist:true,force:false});
 if(await profileOriginFilesHash(cache)!==source.filesHash)throw new Error("The private accepted Profile cache changed.");
 const profile=await inspectOpenPondProfileSource(cache,source.profileId);if(profile.error||!profile.sourcePath)throw new Error("The accepted hosted Profile does not compile.");
 const store=new SqliteStore(input.storeDir);let service:ReturnType<typeof createLocalExperimentImprovementService>|undefined;
 try{
 let workspace=await store.getHarnessWorkspace(workspaceId);
 if(!workspace){workspace=(await importProfileIntoLocalHarnessWorkspace({store,storeDir:input.storeDir,id:workspaceId,ownerId:actor.actorId,name:source.profileId,profile,sourceRevision:source.sourceRevision,repositoryId:source.repositoryId,selectionEligible:false,
  originMetadata:{profileExperimentOrigin:{schemaVersion:"openpond.profileExperimentOrigin.v1",...actor,sourceRevision:source.sourceRevision,sourcePath:cache,sourceFilesHash:source.filesHash},hostedImprovementOwner:true}})).workspace;}
 const ref={source:"openpond_git" as const,repositoryId:source.repositoryId,profileId:source.profileId};
 const authorizer=async()=>{signal.throwIfAborted();if(await profileOriginFilesHash(cache)!==source.filesHash||await profileOriginFilesHash(source.repoPath)!==source.filesHash)throw new Error("Accepted source changed during private candidate I/O.");};
 if(input.operation==="advanced"){
  if(!input.advanced)throw new Error("Missing actual hosted advanced owner command.");
  return runHostedAdvancedRefinerOwner({store,storeDir:input.storeDir,actor,profile,workspace,source,evidence,request:input.advanced,authorize:authorizer,signal});
 }
 const readback=():ImprovementAdoptionReadback=>{if(!input.adoptionReadback)throw new Error("Actual hosted Git owner has not returned its sealed adoption receipt.");return z.object({receipt:z.object({id:z.string(),contentHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),activeRelease:z.object({id:z.string(),contentHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),testedCandidateRelease:z.object({id:z.string(),contentHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),executableSourceHash:z.string().regex(/^[a-f0-9]{64}$/),protectedClosureHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(input.adoptionReadback);};
 service=createLocalExperimentImprovementService({store,storeDir:input.storeDir,projectHumanComparison:async()=>{await authorizer();if(!input.humanProjection)throw new Error("The current private Human comparison owner is unavailable.");return verifyHumanComparisonProjection(input.humanProjection);},authorizeOwner:async(selected,owner,selectedRef,_project,options)=>{
  if(contentHash(selected)!==contentHash(actor)||contentHash(selectedRef)!==contentHash(ref)||owner.id!==workspaceId)throw new Error("Hosted candidate source owner changed.");
  if(options.requireCurrentBase&&(owner.currentChannel.release?.contentHash!==workspace!.currentChannel.release?.contentHash||source.sourceRevision!==(owner.metadata.profileExperimentOrigin as {sourceRevision:string}).sourceRevision))throw new Error("Hosted candidate accepted revision changed.");await authorizer();},
  loadEvidence:async(selected,reference)=>{if(contentHash(selected)!==contentHash(actor))throw new Error("Hosted candidate evidence actor changed.");const retained=[evidence,...additionalEvidence].find(value=>value.manifest.id===reference.id&&value.result.contentHash===reference.contentHash&&value.manifest.teamId===actor.teamId);if(!retained)throw new Error("Hosted candidate exact retained evidence changed.");await authorizer();return retained;},freezeProfile:async(_actor,state,result)=>{
   const baseRecord=await store.getHarnessReleaseRecord(state.baseRelease.contentHash);if(!baseRecord)throw new Error("Hosted source baseline is missing.");const base=await compileLocalHarnessSource({workspaceId:typeof baseRecord.agentSnapshot.metadata.workspaceId==="string"?baseRecord.agentSnapshot.metadata.workspaceId:baseRecord.workspaceId,sourceDir:path.join(baseRecord.bundlePath,"source")}),edited=await compileLocalHarnessSource({workspaceId:typeof result.release.agentSnapshot.metadata.workspaceId==="string"?result.release.agentSnapshot.metadata.workspaceId:result.release.workspaceId,sourceDir:path.join(result.release.bundlePath,"source")});
   return withRemoteProfileCandidateSnapshot({store,storeDir:input.storeDir,state},async staging=>{await applyCandidateProfileSource({...staging,state,base,candidate:edited});const modified=await inspectOpenPondProfileSource(staging.root,state.profileRef.profileId),candidate=await compileOriginalCandidateProfile({storeDir:input.storeDir,state,profile:modified,sourceRevision:result.profileSourceRevision,base}),identity=compiledCandidateExecutableIdentity(candidate);if(identity.protectedClosureHash!==compiledCandidateExecutableIdentity(base).protectedClosureHash)throw new Error("Hosted source candidate changed protected evaluation closure.");const archive=path.join(input.storeDir,"library","profile-candidate-archives",state.id,identity.contentHash);await fs.mkdir(path.dirname(archive),{recursive:true,mode:0o700});if(!await fs.stat(archive).catch(()=>null))await fs.cp(staging.root,archive,{recursive:true,errorOnExist:true,force:false});const retained=await inspectOpenPondProfileSource(archive,state.profileRef.profileId),readback=await compileOriginalCandidateProfile({storeDir:input.storeDir,state,profile:retained,sourceRevision:result.profileSourceRevision,base});if(readback.harnessRelease.contentHash!==candidate.harnessRelease.contentHash)throw new Error("Hosted frozen Profile archive readback differs.");const release=await materializeLocalHarnessRelease({storeDir:input.storeDir,workspaceId:result.release.workspaceId,compiled:candidate,createdAt:result.release.createdAt});await authorizer();return{...result,release,executableIdentity:identity};});},
  adopt:async()=>readback(),readAdoption:async()=>input.adoptionReadback?readback():null,rollback:async()=>readback()});
 const tools=createExperimentCandidateTools({store,improvements:service,actorId:async()=>actor.actorId,teamId:async()=>actor.teamId,loadProfile:async selected=>{if(contentHash(selected)!==contentHash(ref))throw new Error("Candidate requested another source owner.");return profile;},agentRuntime:input.agentRuntime,operationSignal:signal,loadAgentRuntime:createCandidateAgentRuntimeLoader({storeDir:input.storeDir,loadArchive:createWorkAgentSdkArchiveLoader({storeDir:input.storeDir})})});
 if(input.operation==="describe"){
  await authorizer();
  const selected=workspace.currentChannel.release;
  const record=selected?await store.getHarnessReleaseRecord(selected.contentHash):null;
  if(!selected||!record||record.workspaceId!==workspace.id
    ||record.harnessRelease.id!==selected.id||record.harnessRelease.contentHash!==selected.contentHash
    ||workspace.ownerScope.kind!=="personal"||workspace.ownerScope.id!==actor.actorId){
    throw new Error("Hosted source release is unavailable to its admitted owner.");
  }
  const compiled=await compileLocalHarnessSource({workspaceId:typeof record.agentSnapshot.metadata.workspaceId==="string"?record.agentSnapshot.metadata.workspaceId:workspaceId,sourceDir:path.join(record.bundlePath,"source")});
  if(compiled.harnessRelease.contentHash!==record.harnessRelease.contentHash)throw new Error("Hosted source compiler readback changed.");
  const catalog=await profileEvaluationsForRuntime({runtime:{release:record},ref,sourceRevision:source.sourceRevision,harnessRelease:selected}),readJson=(name:string)=>{const bytes=compiled.sourceFiles.find(file=>file.path===name)?.bytes;return bytes?JSON.parse(Buffer.from(bytes).toString("utf8")):null;};
  await authorizer();
  return{workspaceId,ownerRevision:workspace.revision,profileRef:ref,baseRelease:workspace.currentChannel.release,profileSourceRevision:source.sourceRevision,manifest:compiled.manifest,executable:compiledCandidateExecutableIdentity(compiled),catalogHash:catalog.catalogHash,workflows:readJson("workflows/catalog.json"),actions:readJson("workflows/actions.json")};
 }
 if(input.operation==="command"){
  const request=input.command;if(!request)throw new Error("Missing canonical Improve command.");
  if(request.operation==="start")return service.start(actor,request.request);
  if(request.operation==="list")return service.list(actor,request.limit,request.cursor);
  if(!("id" in request))throw new Error("Discover exact hosted source choices through the authenticated host.");
  let state=await service.read(actor,request.id);
  if(request.operation==="read")return state;
  if(request.operation==="instructions"){const partition=await service.partition(actor,state.id),file=await resolveContainedRegularFile(partition.sourceRoot,state.component.path),bytes=await fs.readFile(file);if(bytes.length>250000)throw new Error("Instruction editor size limit exceeded.");let text=bytes.toString("utf8");if(state.component.kind==="workflow"){const row=JSON.parse(text).workflows?.find((value:{id:string})=>value.id===state.component.workflowId);if(row?.invocation?.kind!=="instructions")throw new Error("Use Work to author this executable Workflow.");text=row.invocation.instructions;}return{candidateId:state.id,candidateRevision:state.revision,path:state.component.path,text,textHash:sha256(text),contentHash:sha256(bytes)};}
  if(request.operation==="humanComparisonOptions")throw new Error("Read the actual paired sources through their current hosted Experiment owner.");
  if(!("revision" in request)||state.revision!==request.revision)throw new Error("Candidate revision changed.");
  if(request.operation==="edit")return service.edit(actor,state.id,state.revision,request.expectedFileHash,request.text);
  if(request.operation==="mode")return service.setMode(actor,state.id,state.revision,request.mode);
  if(request.operation==="freeze")return service.freeze(actor,state.id,state.revision);
  if(request.operation==="useCandidate")return service.useCandidate(actor,state.id,state.revision);
  if(request.operation==="rollback")return service.rollback(actor,state.id,state.revision);
  if(request.operation==="discard")return service.discard(actor,state.id,state.revision);
  throw new Error("Hosted Work/test lifecycle requires the actual host turn/run admission.");
 }
 if(!input.candidateId)throw new Error("Missing actual hosted candidate ID.");const state=await service.read(actor,input.candidateId);
 if(input.operation==="beginAdoption")return service.beginAdoption(actor,state.id,input.revision!);
 if(input.operation==="export")return exportHostedProfileCandidate(store,state,"hosted_execution");
 if(input.operation==="source"){
  if(!state.frozen||state.status!=="frozen"&&state.status!=="testing"&&state.status!=="ready_for_review"&&state.status!=="adopting")throw new Error("Only the exact frozen source can enter hosted preparation.");
  const record=await store.getHarnessReleaseRecord(state.frozen.release.contentHash);if(!record||record.harnessRelease.id!==state.frozen.release.id)throw new Error("Frozen hosted source is unavailable.");const compiled=await compileLocalHarnessSource({workspaceId:typeof record.agentSnapshot.metadata.workspaceId==="string"?record.agentSnapshot.metadata.workspaceId:record.workspaceId,sourceDir:path.join(record.bundlePath,"source")}),identity=compiledCandidateExecutableIdentity(compiled);
  if(compiled.harnessRelease.contentHash!==state.frozen.release.contentHash||identity.contentHash!==state.frozen.executableSourceHash||identity.protectedClosureHash!==state.frozen.protectedClosureHash)throw new Error("Frozen hosted executable changed.");
  const repoPath=path.join(input.storeDir,"library","profile-candidate-archives",state.id,identity.contentHash),actual=await inspectOpenPondProfileSource(repoPath,state.profileRef.profileId);if(actual.error||!actual.sourcePath)throw new Error("Frozen actual Profile archive is unavailable.");const baseRecord=await store.getHarnessReleaseRecord(state.baseRelease.contentHash);if(!baseRecord)throw new Error("Frozen baseline is unavailable.");const base=await compileLocalHarnessSource({workspaceId:typeof baseRecord.agentSnapshot.metadata.workspaceId==="string"?baseRecord.agentSnapshot.metadata.workspaceId:baseRecord.workspaceId,sourceDir:path.join(baseRecord.bundlePath,"source")}),readback=await compileOriginalCandidateProfile({storeDir:input.storeDir,state,profile:actual,sourceRevision:state.frozen.profileSourceRevision,base});if(readback.harnessRelease.contentHash!==state.frozen.release.contentHash||compiledCandidateExecutableIdentity(readback).contentHash!==identity.contentHash)throw new Error("Actual frozen Profile archive differs from its compiled release.");
  return{state,profileSource:{repoPath,profileId:state.profileRef.profileId,sourceRevision:state.frozen.profileSourceRevision,repositoryId:state.profileRef.repositoryId,filesHash:await profileOriginFilesHash(repoPath)},sourcePackage:createHarnessSourcePackage({agentSnapshot:compiled.agentSnapshot,harnessRelease:compiled.harnessRelease,files:new Map(compiled.sourceFiles.map(file=>[file.path,file.bytes]))})};
 }
  if(input.operation==="comparison"){if(!input.baseline||!input.candidate)throw new Error("Missing actual hosted paired evidence.");return service.completeComparison(actor,state.id,input.revision!,verifyExperimentEvidence(input.baseline),verifyExperimentEvidence(input.candidate),input.humanSelections);}
 if(input.operation==="beginTesting")return service.beginTesting(actor,state.id,input.revision!,input.recipe);
 if(input.operation==="failTesting"){if(!input.failure)throw new Error("Missing actual hosted test failure.");return service.failTesting(actor,state.id,input.revision!,input.failure.message,input.failure.cancelled);}
 if(input.operation==="cancelTesting")return service.cancelTesting(actor,state.id,input.revision!);
 if(input.operation==="queue"){if(!input.queued)throw new Error("Missing actual hosted queue admission.");return service.queueAuthoringTurn(actor,state.id,input.revision!,input.queued.sessionId,input.queued.turnId,input.queued.createdAt);}
 if(input.operation==="cancelQueued")return service.cancelQueuedAuthoring(actor,state.id,input.revision!);
 if(input.operation==="bind"||input.operation==="finish"||input.operation==="tool"||input.operation==="toolCatalog"){
  if(!input.actualSession||!input.actualTurn||input.actualTurn.sessionId!==input.actualSession.id||input.actualSession.cloudTeamId!==actor.teamId||contentHash(input.actualSession.currentProfile)!==contentHash(ref))throw new Error("Actual hosted candidate Work binding changed.");
  const session:Session=input.actualSession,turn:Turn=input.actualTurn;
  const priorSession=await store.getSession(session.id);if(!priorSession)await store.insertSessionAtFront(session);else if(contentHash({...priorSession,updatedAt:session.updatedAt,status:session.status})!==contentHash(session))throw new Error("Retained hosted candidate session changed.");
  const priorTurn=await store.getTurn(turn.id);if(!priorTurn)await store.insertTurn(turn);else{if(priorTurn.sessionId!==turn.sessionId||contentHash(priorTurn.metadata.refinementCandidate)!==contentHash(turn.metadata.refinementCandidate)||priorTurn.prompt!==turn.prompt)throw new Error("Actual hosted candidate turn identity changed.");await store.updateTurn(turn.id,()=>turn);}
  if(input.operation==="bind")return service.bindAuthoringTurn(actor,state.id,input.revision!,session.id,turn.id);
  if(input.operation==="finish")return service.finishAuthoring(actor,state.id,input.revision!);
  if(input.operation==="toolCatalog"){await tools.candidateAuthoringForTurn(session.id,turn.id);return [...createAuthoringModelToolDefinitions({loadProfileState:async()=>profile,resolveCandidateProfile:tools.resolveCandidateProfile,executeCandidateAgentCommand:tools.executeCandidateAgentCommand}),...candidateFileToolDefinitions(async()=>{throw new Error("Hosted file tools require a bound private call.");}),{name:"exec_command",description:"Run a bounded command confined to the selected public candidate component.",parameters:{type:"object",additionalProperties:false,properties:{command:{type:"string",minLength:1,maxLength:20000},cwd:{type:"string"}},required:["command"]}},{name:"view_image",description:"Inspect an image inside the candidate public source tree.",parameters:{type:"object",additionalProperties:false,properties:{path:{type:"string"}},required:["path"]}}].map(({name,description,parameters})=>({name,description,parameters}));}
  if(!input.tool)throw new Error("Missing candidate tool call.");await tools.authorizeCandidateTool({sessionId:session.id,turnId:turn.id,name:input.tool.name});
  const context={session,turnId:turn.id,args:input.tool.args,callId:input.tool.callId,signal,workspaceDiffBaseline:null,turnPermissions:{approvalPolicy:"never" as const,sandbox:"workspace-write" as const,codexPermissionMode:"default" as const},provider:session.provider,model:turn.modelRef?.modelId??session.modelRef?.modelId??"",mentionedApps:[],userPrompt:turn.prompt,turnMetadata:turn.metadata};
  if(input.tool.name==="get_profile"||input.tool.name.startsWith("agent_")||input.tool.name==="ask_user"){const definition=createAuthoringModelToolDefinitions({loadProfileState:async()=>profile,resolveCandidateProfile:tools.resolveCandidateProfile,executeCandidateAgentCommand:tools.executeCandidateAgentCommand}).find(value=>value.name===input.tool!.name);if(!definition)throw new Error("Candidate authoring tool is unavailable.");return definition.execute(context);}
  if(input.tool.name==="view_image")return tools.executeCandidateImage(context);
  if(input.tool.name==="exec_command")return tools.executeCandidateCommand(context,{session,turnId:turn.id,command:z.string().min(1).max(20000).parse(input.tool.args.command),cwd:typeof input.tool.args.cwd==="string"?input.tool.args.cwd:null,signal:context.signal,source:"model_tool"});
  if(["list_files","read_files","search_files","workspace_status","write_file","write_files","edit_file","delete_file"].includes(input.tool.name))return tools.executeCandidateWorkspaceTool({session,turnId:turn.id,request:WorkspaceToolRequestSchema.parse({action:input.tool.name,args:input.tool.args,source:"chat_action"})});
  throw new Error("This hosted tool has no confined candidate transport.");
 }
 throw new Error("Unknown private hosted Improve operation.");
 }finally{await service?.close();await store.close();}
}
