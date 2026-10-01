import {z} from "zod";
import {verifyExperimentEvidence} from "@openpond/evals/experiments";
import {verifyExperimentScoringPass} from "./experiment-scoring-contracts.js";
import {contentHash} from "@openpond/harness";
import {verifyProfileExternalDatasetBinding,type ProfileExternalDatasetBinding} from "@openpond/evals";
import {ExperimentFieldMappingsSchema} from "./experiment-field-mappings.js";
import {validateTasksetPackage,type TasksetPackage} from "./taskset-packages.js";

export type ExternalDatasetGraderPin={id:string;version:string;contentHash:string;feedbackKey:string;release:{id:string;revision:number|string;contentHash:string}|null};
/** Recompute admission from actual authorized releases. None of the binding's
 * self-declared hashes grants Dataset or Profile access. */
export function verifyExternalDatasetPackage(input:{binding:ProfileExternalDatasetBinding;packageValue:TasksetPackage;graders:ExternalDatasetGraderPin[];actualGrading?:{pass:unknown;evidence:unknown}}) {
  const binding=verifyProfileExternalDatasetBinding(input.binding),value=validateTasksetPackage(input.packageValue),taskset=value.taskset;
  if(taskset.id!==binding.dataset.id||taskset.revision!==binding.dataset.revision||taskset.contentHash!==binding.dataset.contentHash||value.contentHash!==binding.packageHash
    ||contentHash(taskset.environment)!==binding.environmentHash||contentHash(value.files.filter(file=>file.asset.visibility!=="policy").map(file=>file.asset))!==binding.privateDatasetClosureHash)
    throw new Error("The selected Dataset package, environment or protected closure changed.");
  if(binding.population.length>500)throw new Error("Select at most 500 exact Dataset cases before starting this bounded Profile evaluation.");
  for(const member of binding.population){const task=taskset.tasks.find(task=>task.id===member.taskId);if(!task||task.split!==binding.split)throw new Error("The selected ordered population is outside its exact Dataset split.");
    if(member.fixtureId!==null)throw new Error("This recorded cutoff needs an admitted replay fixture before executing the Profile target.");}
  if(binding.gradingSource){if(!input.actualGrading)throw new Error("The actual selected scoring owner is required for this recipe.");const pass=verifyExperimentScoringPass(input.actualGrading.pass),evidence=verifyExperimentEvidence(z.object({manifest:z.unknown(),result:z.unknown()}).strict().parse(input.actualGrading.evidence));if(pass.status!=="completed"||pass.id!==binding.gradingSource.pass.id||pass.contentHash!==binding.gradingSource.pass.contentHash||evidence.manifest.id!==binding.gradingSource.evidence.id||evidence.result.contentHash!==binding.gradingSource.evidence.contentHash||evidence.manifest.lineage?.scoringPassId!==pass.id||contentHash(evidence.manifest.dataset)!==contentHash(binding.dataset)||contentHash(evidence.manifest.evaluators)!==contentHash(binding.evaluators)||contentHash(binding.fieldMappings)!==contentHash(pass.graders.map(pin=>({graderId:pin.id,fields:pin.mappings??[]}))))throw new Error("The selected scoring owner changed its exact Dataset, measurements or mappings.");const actual=evidence.manifest.population,expected=binding.recordedOrigin?binding.recordedOrigin.members.map(member=>({caseId:member.caseId,seed:member.seed,fixtureId:member.fixtureId})):binding.population.map(member=>({caseId:member.taskId,seed:member.seed,fixtureId:member.fixtureId}));if(actual.length!==expected.length||actual.some((member,index)=>contentHash(member)!==contentHash(expected[index])))throw new Error("The selected scoring population differs from the exact ordered original cases and cutoffs.");}
  else {
  if(binding.fieldMappings.some(row=>!taskset.graders.some(grader=>grader.id===row.graderId)))throw new Error("The field mappings name a grader outside the selected release.");
  for(const row of binding.fieldMappings)ExperimentFieldMappingsSchema.parse(row.fields);
  const selected=binding.evaluators.map(evaluator=>{const pin=input.graders.find(pin=>pin.feedbackKey===evaluator.feedbackKey&&contentHash(pin.release??{id:pin.id,revision:pin.version,contentHash:pin.contentHash})===contentHash(evaluator.release));if(!pin)throw new Error("Select an exact released Dataset grader for this external recipe.");return pin;});
  if(binding.fieldMappings.some(row=>!selected.some(pin=>pin.id===row.graderId)))throw new Error("Field mappings refer to an unselected grader.");
  const evaluators=selected.map(pin=>({release:pin.release??{id:pin.id,revision:pin.version,contentHash:pin.contentHash},feedbackKey:pin.feedbackKey,
    configurationHash:contentHash({graderHash:pin.contentHash,mappings:binding.fieldMappings.find(row=>row.graderId===pin.id)?.fields??[]}),output:"score" as const,categories:[]}));
  if(contentHash(evaluators)!==contentHash(binding.evaluators))throw new Error("The external recipe's graders or mappings differ from the current exact released grading settings.");
  for(const pin of input.graders)if(!taskset.graders.some(grader=>grader.id===pin.id&&grader.version===pin.version&&contentHash(grader)===pin.contentHash))throw new Error("External grader pins differ from the actual Dataset implementation.");
  }
  for(const pin of input.graders)if(!taskset.graders.some(grader=>grader.id===pin.id&&grader.version===pin.version&&contentHash(grader)===pin.contentHash))throw new Error("Dataset-native grader pins differ from their actual implementation.");
  return value;
}
