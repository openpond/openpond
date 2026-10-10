import { sha256 } from "@openpond/harness";
import type { TasksetSourceRef } from "@openpond/contracts";
import type { TasksetDraftWorkspace } from "openpond-sdk/taskset-drafts";
import { scanAndRedactEvidence } from "./privacy.js";
import { approvedLicenseStatus } from "./dataset-imports/source-policy.js";

/** Source checks describe the captured sample only. Keep its original bytes,
 * findings and upstream revision uncertainty independently inspectable. */
export function checkCapturedHuggingFaceSource(source:TasksetSourceRef,bytes:Uint8Array):TasksetSourceRef {
  if(source.schemaVersion!=="openpond.huggingFaceDatasetSource.v1")throw new Error("Selected source checks require a captured Hugging Face sample.");
  const hash=sha256(bytes);
  if(source.metadata.capturedSourceHash!==hash || !source.sourceFileHashes.includes(hash))throw new Error("The captured source bytes do not match their retained hash.");
  const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  const scan=scanAndRedactEvidence(text);
  return {...source,secretScanStatus:scan.secretStatus,piiScanStatus:scan.piiStatus,
    licensingStatus:approvedLicenseStatus(source.declaredLicense,false),
    metadata:{...source.metadata,privacyScanner:"openpond-evidence-v1",findings:scan.findings,checkedSourceHash:hash}};
}

export function checkCapturedDatasetSources(workspace:TasksetDraftWorkspace):TasksetSourceRef[] {
  let checked=0;
  const sources=workspace.draft.sourceRefs.map(source=>{
    if(source.schemaVersion!=="openpond.huggingFaceDatasetSource.v1" || typeof source.metadata.capturedSourcePath!=="string")return source;
    const file=workspace.files.find(file=>file.path===source.metadata.capturedSourcePath);
    if(!file)throw new Error("The captured source file is missing.");
    const bytes=Buffer.from(file.base64,"base64");
    if(sha256(bytes)!==file.contentHash || bytes.byteLength!==file.sizeBytes)throw new Error("The captured source file failed integrity verification.");
    checked++;
    return checkCapturedHuggingFaceSource(source,bytes);
  });
  if(!checked)throw new Error("This Dataset has no captured Hugging Face samples to check.");
  return sources;
}
