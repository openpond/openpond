import {z} from "zod";
import path from "node:path";
import {lstat,readFile,realpath} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {contentHash} from "@openpond/harness";
import {ProfileExternalDatasetBindingSchema,ProfileSourceCandidateSchema,verifyProfileExternalDatasetBinding} from "@openpond/evals";
import {verifyExternalDatasetPackage} from "openpond-sdk/experiments";
import {validateTasksetPackage} from "openpond-sdk/taskset-packages";
import type {AgentHostStorageClient} from "@openpond/agent-runtime";
import type {LocalHarnessReleaseRecord} from "../store/store-harness-release-record.js";
import type {ProfileExternalDatasetResolver} from "./profile-external-dataset-admission.js";
import {compileLocalHarnessSource} from "./local-harness-workspace-service.js";
import {compiledCandidateExecutableIdentity} from "./experiment-candidate-equivalence.js";
const Grader=z.object({id:z.string(),version:z.string(),contentHash:z.string().regex(/^[a-f0-9]{64}$/),feedbackKey:z.string(),release:z.object({id:z.string(),revision:z.union([z.string(),z.number()]),contentHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().nullable()}).strict();
const Envelope=z.object({binding:ProfileExternalDatasetBindingSchema,packageValue:z.unknown(),graders:z.array(Grader).max(100),actualGrading:z.object({pass:z.unknown(),evidence:z.unknown()}).strict().optional(),sourceCandidate:ProfileSourceCandidateSchema.optional()}).strict();
export type HostProfileExternalDataset=z.infer<typeof Envelope>;
/** Private bootstrap file. Gold and grader files remain in the verifier owner;
 * the case service sends only policyTaskView and admitted policy attachments. */
export async function readHostProfileExternalDataset(file:string,home:string){const root=await realpath(home),actual=path.resolve(file);if(path.dirname(actual)!==root||await realpath(actual)!==actual)throw new Error("External Dataset package escaped its private owner home.");const stat=await lstat(actual);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32*1024*1024)throw new Error("External Dataset package is not a bounded regular file.");const value=Envelope.parse(JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(await readFile(actual))));value.binding=verifyProfileExternalDatasetBinding(value.binding);value.packageValue=verifyExternalDatasetPackage({...value,packageValue:validateTasksetPackage(value.packageValue)});return value;}
export async function createHostProfileExternalDataset(input:{value:HostProfileExternalDataset;release:LocalHarnessReleaseRecord;sourceRevision:string;client:AgentHostStorageClient}){
 const value=Envelope.parse(input.value),binding=verifyProfileExternalDatasetBinding(value.binding),release=input.release,reference={id:release.harnessRelease.id,contentHash:release.harnessRelease.contentHash};
 if(binding.protectedProfileClosureHash!==contentHash(release.harnessRelease.files.filter(file=>file.visibility!=="policy").map(asset=>({path:asset.path,asset}))))throw new Error("The external Dataset protected Profile closure changed.");
 if(value.sourceCandidate){const compiled=await compileLocalHarnessSource({workspaceId:typeof release.agentSnapshot.metadata.workspaceId==="string"?release.agentSnapshot.metadata.workspaceId:release.workspaceId,sourceDir:path.join(release.bundlePath,"source")});if(contentHash(value.sourceCandidate.harnessRelease)!==contentHash(reference)||compiledCandidateExecutableIdentity(compiled).protectedClosureHash!==value.sourceCandidate.protectedClosureHash)throw new Error("The external Dataset candidate differs from its retained frozen compiled source.");}
 const authorize=async(params?:{bindingHash:string;manifestHash?:string;taskId?:string;seed?:string})=>{const response=z.object({authorized:z.literal(true),bindingHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(await input.client.request({contractVersion:1,requestId:randomUUID(),operation:"profile.externalDataset.authorize",params:{...params,bindingHash:binding.contentHash}}));if(response.bindingHash!==binding.contentHash)throw new Error("The host authorized another external Dataset binding.");};
 const resolveExternalDataset:ProfileExternalDatasetResolver=async(request,selected)=>{await authorize();if(contentHash(request)!==contentHash(binding)||selected.profileRef.profileId!==binding.profileId||selected.sourceRevision!==input.sourceRevision||contentHash(selected.harnessRelease)!==contentHash(reference))throw new Error("External Dataset requested another actual Profile source or recipe.");const packageValue=verifyExternalDatasetPackage({...value,binding:request,packageValue:validateTasksetPackage(value.packageValue)});return{binding,packageValue,authorize};};
 return{authorize,resolveExternalDataset,sourceCandidate:value.sourceCandidate};
}
