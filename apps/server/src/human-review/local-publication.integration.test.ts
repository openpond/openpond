import {mkdtemp,rm,writeFile,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {createServer} from "node:http";
import {once} from "node:events";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import type {AddressInfo} from "node:net";
import {expect,test} from "vitest";
import {contentHash} from "@openpond/harness";
import {createEnvironmentRelease,createVerifierSetRelease,bindTasksetExecutionReleases} from "@openpond/evals";
import {verifyHumanComparisonProjection,HumanReviewViewSchema} from "@openpond/evals/human-review";
import {OpenPondHumanReviewClient} from "openpond-sdk/human-review";
import {TasksetReleaseSchema} from "@openpond/evals/tasksets";
import {createTasksetPackage} from "openpond-sdk/taskset-packages";
import {SqliteStore} from "../store/store.js";
import {createLocalExperimentService} from "../evaluations/local-experiment-service.js";
import {createLocalHumanReviewRuntime} from "./runtime.js";
import {exportLocalHumanEvidence} from "./local-export.js";
import {readLocalHumanPublicationRefs} from "./local-sharing.js";
import {createHttpRequestHandler,type HttpRouteDeps} from "../api/http-routes.js";
// Failure story: a local export must bind a real sealed owner receipt, omit
// evaluator-only bytes and recover the same publication references after restart.
// The authenticated CLI must read the same assignment and source identities.
// This exercises real local services/SQLite/HTTP/CLI, not hosted publication ACLs.
test("local retained evidence export and authenticated Human CLI preserve exact owner/source boundaries",async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),"human-local-publication-"));let store=new SqliteStore(directory),actorId="actor",dispatches=0;
 const rubric="Assess observed clarity",asset={id:"rubric",path:"grader/rubric.txt",contentHash:createHash("sha256").update(rubric).digest("hex"),sizeBytes:Buffer.byteLength(rubric),mediaType:"text/plain",visibility:"verifier" as const};
 const form={schemaVersion:"openpond.humanForm.v1" as const,mode:"individual" as const,instructions:"Assess observed output",criteria:[{id:"clarity",label:"Clarity",instructions:"Use the output",kind:"score" as const,minimum:1,maximum:5,step:1,required:true,allowAbstain:true}]};
 const environment=createEnvironmentRelease({schemaVersion:"openpond.environmentRelease.v1",id:"text",revision:1,contract:{protocolVersion:"openpond.environment.v1",kind:"text",entrypoint:"text",stateful:false,deterministicSeeds:true,lifecycle:["create","reset","step","collect","destroy"],networkPolicy:"none",defaultTimeoutMs:10000},actionSchemaRef:null,observationSchemaRef:null,stateSchemaRef:null,artifactCollection:{maxArtifacts:1,maxTotalBytes:1024},adapterConformanceHashes:{},metadata:{}});
 const verifierSet=createVerifierSetRelease({schemaVersion:"openpond.verifierSetRelease.v1",id:"human-verifier",revision:1,graders:[{id:"human",version:"1",kind:"human",weight:1,hardGate:false,rewardEligible:false,privileged:true,rubricRef:asset,reviewerRole:"reviewer",form}],isolation:{processBoundary:"isolated_process",networkPolicy:"none",defaultTimeoutMs:1000},calibrationReceiptRefs:[],metadata:{}});
 const body={schemaVersion:"openpond.tasksetRelease.v2",id:"data",revision:1,policy:{policyVisibleFields:["input","policyVisibleContext"],privilegedFields:["expectedOutput"],hiddenGraderRefs:["human"],connectedAppScopes:[]},environment:environment.contract,tools:[],capabilities:[],graders:verifierSet.graders,tasks:[{id:"task",clusterKey:"family",split:"test",input:{prompt:"Respond"},policyVisibleContext:{visible:true},expectedOutput:{private:"DO_NOT_PUBLISH_GOLD"},privilegedContextRef:null,artifactRefs:[],tags:[]}],metadata:{}};
 const taskset=bindTasksetExecutionReleases({taskset:TasksetReleaseSchema.parse({...body,contentHash:contentHash(body)}),environment,verifierSet}),value=createTasksetPackage({schemaVersion:"openpond.tasksetPackage.v1",taskset,environment,verifierSet,files:[{asset,base64:Buffer.from(rubric).toString("base64")}]});
 const experiments=createLocalExperimentService({store,ownerId:"local-owner",actorId:async()=>actorId,teamId:async()=>"team",readHumanTaskPackage:async(scope,projectId,release)=>{if(actorId!=="actor"||scope!=="team"||projectId!=="project"||contentHash(release)!==contentHash({id:taskset.id,revision:taskset.revision,contentHash:taskset.contentHash}))throw new Error("Fixture task package owner changed");return value;},catalog:async()=>({error:null,models:[{id:"model",displayName:"Model",ownedBy:"fixture",streaming:true,raw:{id:"model",object:"model",created:0,owned_by:"fixture",context_window:1000,output_limit:64,capabilities:{samplingParameters:true},metadata:{billing:{pricing:{version:"1",source:"owner",effectiveAt:"2026-10-01T00:00:00.000Z",inputUsdPerMillionTokens:1,cachedInputUsdPerMillionTokens:1,outputUsdPerMillionTokens:1}}}}}]}),stream:async function*(){dispatches++;yield{type:"text_delta",text:"Observed output",raw:{}};yield{type:"usage",usage:{prompt_tokens:5,completion_tokens:2},raw:{}};yield{type:"finish",finishReason:"stop",raw:{}};}});
 const human=createLocalHumanReviewRuntime({store,storeDir:directory,actorId:async()=>actorId,teamId:async()=>"team",localExperiments:experiments});
 const server=createServer(createHttpRequestHandler({host:"127.0.0.1",getActualPort:()=> (server.address() as AddressInfo).port,token:"fixture-capability",version:"fixture",logger:{info(){},warn(){},error(){}},trainingPayload:async(action:unknown,payload:unknown)=>{if(action!=="human_review")throw new Error("Unexpected dispatch");return human.request(payload);}} as unknown as HttpRouteDeps));server.listen(0,"127.0.0.1");await once(server,"listening");
 try{
  await experiments.recover();const execution=await experiments.run({package:value,configuration:{operationId:"run",maximumCostUsd:0.01,request:{schemaVersion:"openpond.modelTasksetRunRequest.v1",operationId:"run",teamId:"team",modelProjectId:null,name:"Local Human evidence",project:{id:"project",revision:1,contentHash:contentHash("project"),targetId:null},taskset:{id:taskset.id,revision:1,contentHash:taskset.contentHash},policy:{kind:"hosted_chat",modelId:"model",maxOutputTokens:64,temperature:0,topP:1},population:[{receiptId:"case",taskId:"task",seed:"0",fixtureId:null}]}}});await experiments.wait(execution.id);
  const input={endpoint:"export_local",scope:"team",projectId:"project",graderId:"human",selections:[{executionId:execution.id,receiptId:"case"}]},deps={store,actorId:async()=>actorId,teamId:async()=>"team"};const first=await exportLocalHumanEvidence(deps,input),retry=await exportLocalHumanEvidence(deps,input);expect(retry.contentHash).toBe(first.contentHash);expect(first.attempts[0]!.origin.kind).toBe("owner_attested_local");expect(first.attempts[0]!.coverage.publishedEventCount).toBe(first.attempts[0]!.events.length);expect(JSON.stringify(first)).not.toContain("DO_NOT_PUBLISH_GOLD");expect(JSON.stringify(first)).not.toContain(rubric);expect(dispatches).toBe(1);
  const snapshot=await human.request({...input,endpoint:"snapshot"}) as {evidence:unknown;form:unknown};const created=await human.request({endpoint:"command",scope:"team",command:{action:"create",id:"review",operationId:"create",expectedRevision:0,projectId:"project",kind:"grade",title:"Review output",...snapshot,assigneeId:null,policy:{approval:"none",minimumRaters:1,managerIds:[],reviewerIds:[],queueClaim:false,teamVisible:false}}});expect(created).toMatchObject({id:"review",evidence:{attempts:[{localSource:{kind:"native_local"}}]}});
  await mkdir(path.join(directory,"secrets"),{recursive:true});
  await writeFile(path.join(directory,"secrets","server-token"),"fixture-capability",{mode:0o600});
  const runCli=async(...args:string[])=>JSON.parse((await promisify(execFile)(process.execPath,[
   "--import","tsx",path.resolve("apps/cli/src/cli/main.ts"),"human-review",...args,
   "--local","--team","team","--server-url",`http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  ],{env:{...process.env,OPENPOND_HOME:directory},timeout:30000,maxBuffer:1048576})).stdout);
  const cli=HumanReviewViewSchema.parse(await runCli("read","review"));
  expect(cli).toMatchObject({id:"review",scope:"team"});
  const requestFile=path.join(directory,"assessment.json");
  await writeFile(requestFile,JSON.stringify({endpoint:"command",scope:"team",command:{
   action:"submit",id:cli.id,operationId:"cli-submit",expectedRevision:cli.revision,
   generation:cli.generation,evidenceHash:contentHash(cli.evidence),formHash:contentHash(cli.form),
   answers:[{criterionId:"clarity",value:4,abstain:false,note:"Observed answer is clear"}],note:"CLI judgment",
  }}),{mode:0o600});
  const accepted=HumanReviewViewSchema.parse(await runCli("request","--input-file",requestFile));
  expect(accepted.status).toBe("accepted");
  expect(HumanReviewViewSchema.parse(await runCli("request","--input-file",requestFile)).contentHash).toBe(accepted.contentHash);
  expect(await runCli("inspect","review")).toMatchObject([{reviewId:"review",output:"Observed output"}]);
  expect(await runCli("results",execution.id)).toMatchObject({
   executionId:execution.id,coverage:{accepted:1},results:[{origin:"native_local",status:"accepted",answers:[{value:4}]}],
  });
  expect(dispatches).toBe(1);
  // Failure story: a lost admission binding is recovered during canonical
  // cancellation. The actual HTTP SDK must accept its extra persisted revision
  // and repeat the same cancellation, while stale noncancel writes still fail.
  const sdk=new OpenPondHumanReviewClient({baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,scope:"team",apiKey:"fixture-capability"});
  const selectedReview={id:accepted.id,revision:accepted.revision,contentHash:accepted.contentHash};
  const sdkResults=await sdk.results(execution.id,[selectedReview]);
  expect(sdkResults).toMatchObject({executionId:execution.id,selection:[selectedReview],coverage:{accepted:1},results:[{status:"accepted",answers:[{value:4}]}]});
  // Failure story: explicit accepted Human evidence may resolve a separate
  // comparison view, but must not rewrite the original pending automatic pass,
  // accept stale selected decisions or outlive current owner/source authority.
  const {expectedRevision:_candidateDraftRevision,...originalConfiguration}=(await store.humanReviewLocalEvidence("team",execution.id)).released.definition.configuration;void _candidateDraftRevision;
  const candidateExecution=await experiments.run({package:value,configuration:{...originalConfiguration,operationId:"run-candidate",request:{...originalConfiguration.request,operationId:"run-candidate",population:[{receiptId:"case-candidate",taskId:"task",seed:"0",fixtureId:null}]}}});await experiments.wait(candidateExecution.id);
  const candidateSnapshot=await sdk.snapshot({projectId:"project",graderId:"human",selections:[{executionId:candidateExecution.id,receiptId:"case-candidate"}]});
  const candidateReview=await sdk.command({action:"create",id:"candidate-review",operationId:"create-candidate-review",expectedRevision:0,projectId:"project",kind:"grade",title:"Review candidate output",...candidateSnapshot,assigneeId:null,policy:{approval:"none",minimumRaters:1,managerIds:[],reviewerIds:[],queueClaim:false,teamVisible:false}});
  const candidateAccepted=await sdk.command({action:"submit",id:candidateReview.id,operationId:"candidate-submit",expectedRevision:candidateReview.revision,generation:candidateReview.generation,evidenceHash:contentHash(candidateReview.evidence),formHash:contentHash(candidateReview.form),answers:[{criterionId:"clarity",value:5,abstain:false,note:"Explicit candidate assessment"}],note:"Candidate judgment"});
  const candidateRef={id:candidateAccepted.id,revision:candidateAccepted.revision,contentHash:candidateAccepted.contentHash},candidateDecision=candidateAccepted.decisions.at(-1)!,candidateResults=await sdk.results(candidateExecution.id,[candidateRef]);
  const originalComparison=await experiments.compare({teamId:"team",baselineId:execution.id,candidateId:candidateExecution.id});
  const automaticHash=originalComparison.baseline.result.contentHash;
  const decision=accepted.decisions.at(-1)!;
  const selectedLane={execution:originalComparison.baseline.manifest.lineage!.execution!,resultHash:sdkResults.contentHash,reviews:[{review:selectedReview,decision:{id:decision.id,revision:decision.revision,contentHash:decision.contentHash}}]};
  const humanSelections={rules:[{feedbackKey:originalComparison.baseline.manifest.evaluators[0]!.feedbackKey,criterionId:"clarity",kind:"normalized_score" as const,minimum:1,maximum:5}],baseline:selectedLane,candidate:{execution:originalComparison.candidate.manifest.lineage!.execution!,resultHash:candidateResults.contentHash,reviews:[{review:candidateRef,decision:{id:candidateDecision.id,revision:candidateDecision.revision,contentHash:candidateDecision.contentHash}}]}};
  const projection=await human.projectComparison({scope:"team",actorId:"actor",projectId:"project",baseline:originalComparison.baseline,candidate:originalComparison.candidate,selections:humanSelections});
  expect(projection.baseline.result.cases[0]!.feedback[0]).toMatchObject({status:"scored",value:0.75,passed:null});
  expect(projection.candidate.result.cases[0]!.feedback[0]).toMatchObject({status:"scored",value:1,passed:null});
  expect(verifyHumanComparisonProjection(projection,originalComparison).contentHash).toBe(projection.contentHash);
  const {contentHash:_projectionHash,...projectionBody}=projection;void _projectionHash;const changed={...projectionBody,original:{...projection.original,baseline:{...projection.original.baseline,manifestHash:contentHash("foreign")}}};expect(()=>verifyHumanComparisonProjection({...changed,contentHash:contentHash(changed)},originalComparison)).toThrow("human_comparison_projection_lineage_changed");
  const changedHumanResults={...projectionBody,humanResults:{...projection.humanResults,baseline:{...projection.humanResults.baseline,results:projection.humanResults.baseline.results.map(result=>({...result,answers:result.answers.map(answer=>({...answer,value:1}))}))}}};
  expect(()=>verifyHumanComparisonProjection({...changedHumanResults,contentHash:contentHash(changedHumanResults)},originalComparison)).toThrow("human_comparison_human_result_changed");
  expect(projection.humanResults.baseline.results[0]!.answers[0]!.value).toBe(4);
  expect(projection.original.baseline.resultHash).toBe(automaticHash);
  expect((await experiments.compare({teamId:"team",baselineId:execution.id,candidateId:execution.id})).baseline.result.contentHash).toBe(automaticHash);
  await expect(human.projectComparison({scope:"team",actorId:"actor",projectId:"project",baseline:originalComparison.baseline,candidate:originalComparison.candidate,selections:{...humanSelections,baseline:{...selectedLane,reviews:[{...selectedLane.reviews[0]!,review:{...selectedReview,revision:selectedReview.revision+1}}]}}})).rejects.toThrow("human_comparison_review_changed");
  actorId="foreign";
  await expect(human.projectComparison({scope:"team",actorId:"actor",projectId:"project",baseline:originalComparison.baseline,candidate:originalComparison.candidate,selections:humanSelections})).rejects.toThrow("human_local_scope_denied");
  actorId="actor";expect(dispatches).toBe(2);
  // A transport returning a different sealed execution must not associate its
  // otherwise valid assessment with this selected retained target output.
  const foreignResultClient=new OpenPondHumanReviewClient({...sdk.options,fetch:async(url,init)=>{
   const response=await fetch(url,init),value=await response.json() as Record<string,unknown>;
   const {contentHash:_hash,...body}=value;void _hash;
   const changed={...body,executionId:"another-retained-execution"};
   return Response.json({...changed,contentHash:contentHash(changed)},{status:response.status});
  }});
  await expect(foreignResultClient.results(execution.id,[selectedReview])).rejects.toMatchObject({status:502,code:"human_result_identity_mismatch"});
  const tasks=await sdk.taskSnapshot({projectId:"project",dataset:{id:taskset.id,revision:taskset.revision,contentHash:taskset.contentHash},graderId:"human",taskIds:["task"]});
  const assignment=await sdk.command({action:"create",id:"cancel-recovery",operationId:"cancel-create",expectedRevision:0,projectId:"project",kind:"execute",title:"Recover existing admission",...tasks,assigneeId:null,policy:{approval:"none",minimumRaters:1,managerIds:[],reviewerIds:[],queueClaim:false,teamVisible:false}});
  const {expectedRevision:_unusedRevision,...retainedConfiguration}=(await store.humanReviewLocalEvidence("team",execution.id)).released.definition.configuration;void _unusedRevision;
  const reserved=await sdk.command({action:"reserve_execution",id:assignment.id,operationId:"reserve-existing",expectedRevision:assignment.revision,generation:assignment.generation,runOperationId:"run",configurationHash:contentHash(retainedConfiguration)});
  const cancellation={action:"cancel" as const,id:assignment.id,operationId:"sdk-cancel",expectedRevision:reserved.revision,note:"Recover the original run and close assignment"};
  const cancelled=await sdk.command(cancellation);
  expect(cancelled.status).toBe("cancelled");expect(cancelled.revision).toBe(reserved.revision+2);expect(cancelled.execution?.executionId).toBe(execution.id);
  expect((await sdk.command(cancellation)).contentHash).toBe(cancelled.contentHash);
  await expect(sdk.command({action:"save_draft",id:accepted.id,operationId:"sdk-stale-draft",expectedRevision:accepted.revision-1,generation:accepted.generation,answers:[],note:"stale"})).rejects.toMatchObject({status:409,code:"human_revision_conflict"});
  expect(dispatches).toBe(2);
  const publication={id:"actual-publication",revision:1,contentHash:contentHash("publication")};await store.rememberHumanLocalPublication({scope:"team",actorId,executionId:execution.id,executionHash:first.attempts[0]!.origin.executionHash,operationId:"publish",publication});const fresh=new SqliteStore(directory);try{expect(await readLocalHumanPublicationRefs({...deps,store:fresh},{endpoint:"local_publications",scope:"team",executionId:execution.id})).toEqual([publication]);}finally{await fresh.close();}
  actorId="foreign";await expect(exportLocalHumanEvidence(deps,input)).rejects.toThrow("human_local_publication_source_denied");await expect(readLocalHumanPublicationRefs(deps,{endpoint:"local_publications",scope:"team",executionId:execution.id})).rejects.toThrow("human_local_publication_source_denied");actorId="actor";await expect(exportLocalHumanEvidence(deps,{...input,projectId:"foreign-project"})).rejects.toThrow("human_local_publication_source_denied");
 }finally{await experiments.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await store.close();await rm(directory,{recursive:true,force:true});}
});
