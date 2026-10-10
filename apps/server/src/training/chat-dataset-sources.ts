import {z} from "zod";
import {canonicalJson,contentHash,sha256} from "@openpond/harness";
import {HuggingFaceDatasetSourceRefSchema} from "@openpond/contracts";
import type {SqliteStore} from "../store/store.js";
import type {createDatasetImportService} from "./dataset-imports/import-service.js";
import {checkCapturedHuggingFaceSource} from "./chat-dataset-source-checks.js";

/** This path captures only explicitly selected inspected rows. The canonical
 * importer still owns full source downloads and materialization. */
export function createChatDatasetSourceAction(deps:{store:SqliteStore;imports:ReturnType<typeof createDatasetImportService>;create:(input:unknown)=>Promise<unknown>}) {
  return async(action:string,payload:Record<string,unknown>,ownerId:string)=>{
    if(action==="inspect_source") {
      const input=z.object({url:z.string().min(1),configuration:z.string().min(1).optional(),split:z.string().min(1).optional()}).strict().parse(payload);
      return deps.imports.inspectHuggingFace({profileId:ownerId,...input});
    }
    const input=z.object({importId:z.string().min(1),operationId:z.string().min(1).max(200),name:z.string().min(1),objective:z.string().min(1),rows:z.array(z.number().int().min(0).max(24)).min(1).max(25),promptField:z.string().min(1),expectedField:z.string().min(1).optional()}).strict().parse(payload);
    const job=await deps.store.getDatasetImportJob(input.importId);
    if(!job || job.profileId!==ownerId || !job.inspection || !job.locator)throw new Error("Inspect this Dataset source before importing a selected sample.");
    const inspection=job.inspection;
    if(inspection.gated || inspection.private)throw new Error("This source requires access that the current importer cannot establish. The inspection is retained.");
    if(new Set(input.rows).size!==input.rows.length)throw new Error("Select each source row once.");
    const preview=z.object({configuration:z.string().min(1),split:z.string().min(1)}).parse(inspection.metadata.selectedPreview);
    const selected=input.rows.map(index=>{const row=inspection.previewRows[index];if(!row)throw new Error("A selected row is outside the retained source preview.");return {index,row};});
    const snapshot=canonicalJson({repositoryId:job.locator.repositoryId,inspectedRevision:inspection.resolvedRevision,previewRevisionVerified:inspection.metadata.previewRevisionVerified===true,...preview,selected,transformation:{promptField:input.promptField,expectedField:input.expectedField ?? null}});
    const bytes=Buffer.from(snapshot),hash=sha256(bytes),path="sources/huggingface-preview.json",sourceId="source-"+hash.slice(0,40);
    const source=checkCapturedHuggingFaceSource(HuggingFaceDatasetSourceRefSchema.parse({schemaVersion:"openpond.huggingFaceDatasetSource.v1",kind:"huggingface",id:sourceId,profileId:ownerId,title:inspection.title,
      sourceHash:contentHash({inspection:inspection.id,snapshotHash:hash}),occurredAt:inspection.inspectedAt,licensingStatus:"pending",secretScanStatus:"pending",piiScanStatus:"pending",
      repositoryId:job.locator.repositoryId,repositoryUrl:job.locator.repositoryUrl,revision:inspection.resolvedRevision,configuration:preview.configuration,upstreamSplits:[preview.split],gated:false,private:false,declaredLicense:inspection.declaredLicense,sourceFileHashes:[hash],
      metadata:{scope:"Selected inspection preview",capturedSourcePath:path,capturedSourceHash:hash,previewRevisionVerified:inspection.metadata.previewRevisionVerified===true,subset:{rowIndexes:input.rows},transformation:{promptField:input.promptField,expectedField:input.expectedField ?? null},inspectionId:inspection.id}}),bytes);
    const field=(row:Record<string,unknown>,key:string)=>key.split(".").reduce<unknown>((value,segment)=>value && typeof value==="object" && !Array.isArray(value) ? (value as Record<string,unknown>)[segment] : undefined,row);
    const tasks=selected.map(({index,row})=>{
      const prompt=field(row,input.promptField),expected=input.expectedField ? field(row,input.expectedField) : undefined;
      if(typeof prompt!=="string" || !prompt.trim() || input.expectedField && expected===undefined)throw new Error("Selected source fields cannot be mapped to a task. Revise the mapping.");
      return {schemaVersion:"openpond.taskData.v1",id:`source-row-${index}`,clusterKey:`source-row-${index}`,split:"validation",input:{prompt},expectedOutput:expected===undefined ? null : {text:typeof expected==="string" ? expected : JSON.stringify(expected)},policyVisibleContext:{},privilegedContextRef:null,sourceRefs:[sourceId],tags:[],metadata:{sourceRow:index}};
    });
    return deps.create({action:"create",operationId:input.operationId,payload:{name:input.name,files:[{path,contentHash:hash,sizeBytes:bytes.byteLength,base64:bytes.toString("base64")}],draft:{objective:input.objective,tasks,sourceRefs:[source],metadata:{sourceSample:{scope:"Selected source preview sample",taskCount:tasks.length,upstreamRevisionVerified:inspection.metadata.previewRevisionVerified===true}}}}});
  };
}
