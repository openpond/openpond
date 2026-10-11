import { mkdtemp,rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect,test } from "vitest";
import { contentHash,sha256 } from "@openpond/harness";
import { SqliteStore } from "../store/store.js";
import { createLocalDatasetService } from "./local-dataset-service.js";
import type { LocalDatasetRecord } from "@openpond/contracts";

// Failure story: workbook fixtures must use pinned private bytes and the real
// no-network process runner, not qualify a filename claim or expose host files.
// Calibration must also qualify a scored hard gate with zero aggregate weight.
test("artifact grader examples execute privately and reject unpinned bytes",async()=>{
  const home=await mkdtemp(path.join(os.tmpdir(),"openpond-artifact-fixtures-"));const store=new SqliteStore(home);
  try {
    const service=createLocalDatasetService({store,home});
    const assetPath="fixtures/good/result.bin",assetId=`taskset-file-${contentHash(assetPath)}`;
    const file=(path:string,source:string)=>{const bytes=Buffer.from(source);return {path,contentHash:sha256(bytes),sizeBytes:bytes.length,base64:bytes.toString("base64")};};
    const source=`import fs from 'node:fs'; export function verify({artifacts}) { let denied=false; try { fs.readFileSync(${JSON.stringify(path.join(home,"state","state.sqlite"))}); } catch { denied=true; } const passed=denied && artifacts.length===1 && Buffer.from(artifacts[0].base64,'base64').toString()==='verified bytes'; return {score:passed?1:0,passed,feedback:'Pinned artifact and isolated filesystem',evidenceRefs:[]}; }`;
    const created=await service.request({action:"create",operationId:"artifact-examples",payload:{name:"Artifact examples",files:[file("verifiers/check.mjs",source),file(assetPath,"verified bytes")],draft:{objective:"Check private artifacts",tasks:[{schemaVersion:"openpond.taskData.v1",id:"one",clusterKey:"one",split:"validation",input:{prompt:"Return a file"},expectedOutput:null,policyVisibleContext:{},privilegedContextRef:null,sourceRefs:[],tags:[],metadata:{}}],graders:[{id:"artifact-check",version:"1",label:"Artifact check",kind:"custom_verifier",runtime:"sandbox_process",module:"verifiers/check.mjs",exportName:"verify",timeoutMs:10000,networkPolicy:"none",weight:1,hardGate:true,rewardEligible:false,privileged:true,metadata:{}}],graderFixtures:[true,false].map(good=>({id:good?"good":"missing",taskId:"one",label:good?"positive":"negative",output:{text:"done"},infrastructureError:null,expectedPassed:good,expectedRewardEligible:false,metadata:{artifactAssetIds:good?[assetId]:[]}}))}}}) as {record:LocalDatasetRecord};
    const id=created.record.workspace.draft.id;
    await service.request({action:"save_grader",id,expectedRevision:1,operationId:"zero-weight-gate",payload:{grader:{id:"artifact-gate",version:"1",label:"Artifact gate",kind:"file",weight:0,hardGate:true,rewardEligible:false,privileged:false,config:{refIncludes:"result.bin"},metadata:{}}}});
    const checked=await service.request({action:"check_graders",id,expectedRevision:2}) as {check:{status:string;checked:number;issues:unknown[]}};
    expect(checked.check).toMatchObject({status:"passed",checked:4,issues:[]});
    const fixtures=created.record.workspace.draft.graderFixtures.map(fixture=>({...fixture,metadata:{artifactAssetIds:["unavailable-asset"]}}));
    await service.request({action:"save",id,expectedRevision:2,operationId:"invalid-artifacts",payload:{draft:{graderFixtures:fixtures}}});
    const invalid=await service.request({action:"check_graders",id,expectedRevision:3}) as {check:{status:string;checked:number}};
    expect(invalid.check).toMatchObject({status:"unavailable",checked:0});
  } finally {await store.close();await rm(home,{recursive:true,force:true});}
});
