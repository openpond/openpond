import { mkdtemp,rm,mkdir,writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect,test } from "vitest";
import { contentHash,sha256 } from "@openpond/harness";
import { SqliteStore } from "../store/store.js";
import { createLocalDatasetService } from "./local-dataset-service.js";
import type { LocalDatasetRecord } from "@openpond/contracts";
import { buildTaskset, computeTasksetHash } from "@openpond/taskset-sdk";
import { prepareAuthoredTasksetSource } from "openpond-sdk/taskset-packages";
import { attemptFixture, tasksetFixture, withTrainingStore } from "../../../../tests/helpers/training-fixtures.js";
import { createTaskEvaluationService } from "./evaluation-service.js";
import { persistBinaryTaskAttemptArtifact } from "./task-attempt-artifact-service.js";
import { tasksetPackageDirectoryId } from "./taskset-package-path.js";

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

  // A published process grader must qualify real private bytes, keep fixture
  // scope separate, deny host files, and reject claimed or changed outputs.
  test("grades immutable process fixtures and owner-recorded output bytes", async () => withTrainingStore(async ({ store, directory }) => {
    const modulePath = "graders/private.mjs", fixturePath = "fixtures/result.bin";
    const fixtureId = `taskset-file-${contentHash(fixturePath)}`;
    const source = `import fs from 'node:fs'; export function verify({artifacts}) { let denied=false; try { fs.readFileSync(${JSON.stringify(path.join(directory, "state/state.sqlite"))}); } catch { denied=true; } const passed=denied && artifacts.length===1 && Buffer.from(artifacts[0].base64,'base64').toString()==='verified bytes'; return {score:Number(passed),passed,feedback:'Checked pinned bytes with filesystem isolation',evidenceRefs:[]}; }`;
    const custom = { id: "private", version: "1", label: "Private artifact", kind: "custom_verifier" as const, runtime: "sandbox_process" as const,
      module: modulePath, exportName: "verify", timeoutMs: 10000, networkPolicy: "none" as const, weight: 1, hardGate: true, rewardEligible: true, privileged: true, metadata: {} };
    const text = { id: "text", version: "1", label: "Text", kind: "state" as const, weight: 0, hardGate: true, rewardEligible: false, privileged: true, config: { fields: ["text"] }, metadata: {} };
    const initial = tasksetFixture({ graders: [custom, text] });
    initial.tasks = initial.tasks.map(task => ({ ...task, privilegedContextRef: null }));
    initial.environment.metadata.runtimeSourceTasksetId = initial.id;
    initial.graderFixtures = [true, false].map(good => ({ id: good ? "private-good" : "private-missing", taskId: "task_eval", label: good ? "positive" : "negative",
      output: { text: "irrelevant" }, infrastructureError: null, expectedPassed: good, expectedRewardEligible: true,
      metadata: { graderIds: [custom.id], artifactAssetIds: good ? [fixtureId] : [] } }));
    initial.graderFixtures.push({ id: "text-good", taskId: "task_eval", label: "positive", output: { text: "Goodbye friend" }, infrastructureError: null,
      expectedPassed: true, expectedRewardEligible: false, metadata: { graderIds: [text.id], expectedScore: 1 } });
    const files = new Map([[modulePath, Buffer.from(source)], [fixturePath, Buffer.from("verified bytes")]]);
    const { taskset } = prepareAuthoredTasksetSource(initial, files, "openpond.desktop.v1");
    const inventory = taskset.metadata.portableFileInventory as { asset: Record<string, unknown>; sourcePath: string }[];
    const verifierFile = inventory.find(file => file.sourcePath === modulePath)!;
    inventory.push({ asset: { ...verifierFile.asset, id: "same-byte-private-alias" }, sourcePath: modulePath });
    taskset.contentHash = computeTasksetHash(taskset);
    const root = path.join(directory, "training/tasksets", tasksetPackageDirectoryId(taskset));
    for (const [relative, bytes] of files) { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), bytes); }
    await buildTaskset(taskset, root);
    await store.upsertTaskset(taskset);
    const selected = { id: taskset.id, revision: taskset.revision, contentHash: taskset.contentHash };
    const service = createTaskEvaluationService({ store, storeDir: directory });
    const audit = await service.auditFixtures({ tasksetId: taskset.id, tasksetRef: selected });
    expect(audit.report).toMatchObject({ passed: true, fixtureRefs: ["private-good", "private-missing", "text-good"] });
    expect(audit.results.map(item => item.result.components.map(component => component.graderId))).toEqual([["private"], ["private"], ["text"]]);
    const attempt = attemptFixture({ metadata: { fixtureLabel: "positive", fixtureId: "private-good" } });
    const grade = async () => service.grade({ tasksetId: taskset.id, tasksetRef: selected, taskId: "task_eval", attempt });
    expect(await grade()).toMatchObject({ passed: false, components: [{ graderId: "private", score: 0 }, { graderId: "text", score: 1 }] });
    const artifact = await persistBinaryTaskAttemptArtifact({ store, storeDir: directory, tasksetId: taskset.id, taskId: "task_eval", attemptId: attempt.id,
      requestId: "owned-output", kind: "output_artifact", bytes: Buffer.from("verified bytes"), mediaType: "application/octet-stream", fileLabel: "result", extension: "bin", timestamp: () => new Date().toISOString() });
    attempt.artifactRefs = [artifact.id];
    expect(await grade()).toMatchObject({ passed: true, score: 1 });
    await writeFile(artifact.path, "tampered bytes");
    expect(await grade()).toMatchObject({ passed: false, score: null, rewardEligible: false, failureClass: "grader_failure" });
    await writeFile(path.join(root, modulePath), "export const verify = () => ({ score: 1, passed: true, feedback: 'forged' });");
    await expect(service.auditFixtures({ tasksetId: taskset.id, tasksetRef: selected })).rejects.toThrow("immutable");
  }));


