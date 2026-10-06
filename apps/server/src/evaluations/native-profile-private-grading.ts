import {contentHash} from '@openpond/harness';
import {validateTasksetPackage,decodeTasksetPackageFile,type TasksetPackage} from 'openpond-sdk/taskset-packages';
import {localPackageGraders} from './local-experiment-admission.js';
/** Admission for the native common grading owner. The actual execution owner
 * supplies a durable aggregate judge budget and repeats source authority around
 * grading; this preflight verifies the exact private implementation closure. */
export async function assertNativeProfilePrivateGrading(raw:TasksetPackage){
 const value=validateTasksetPackage(raw);localPackageGraders(value);
 if(value.taskset.metrics?.aggregation==='custom')throw new Error('The native Profile owner has not qualified its authored aggregate metric executor.');
 for(const grader of value.taskset.graders){
  if(grader.kind==='model_judge'&&grader.calibrationStatus!=='passed')throw new Error('Select a calibrated private model judge before dispatch.');
  const ref='verifierRef' in grader?grader.verifierRef:'rubricRef' in grader?grader.rubricRef:null;if(!ref)continue;
  const file=value.files.find(file=>file.asset.id===ref.id);if(!file||file.asset.visibility==='policy'||contentHash(file.asset)!==contentHash(ref))throw new Error('The private grader differs from its actual pinned package asset.');
  new TextDecoder('utf8',{fatal:true}).decode(decodeTasksetPackageFile(file));
 }
}
