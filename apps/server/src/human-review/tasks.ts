import {contentHash} from "@openpond/harness";
import {HumanEvidenceSchema,HumanFormSchema,type HumanEvidence} from "@openpond/evals/human-review";
import {LearningDomainError} from "@openpond/evals/learning";
import {validateTasksetPackage,type TasksetPackage} from "openpond-sdk/taskset-packages";
import {localPackageGraders} from "../evaluations/local-experiment-admission.js";
export function localHumanTasks(raw:TasksetPackage,graderId:string,dataset:HumanEvidence["dataset"],taskIds:string[]){
  const value=validateTasksetPackage(raw),compiled=value.taskset.graders.find(g=>g.id===graderId),pin=localPackageGraders(value).find(g=>g.id===graderId);
  if(!compiled||compiled.kind!=="human"||!compiled.form||compiled.form.mode!=="individual"||!pin||taskIds.some(id=>!value.taskset.tasks.some(t=>t.id===id)))throw new LearningDomainError("human_structured_task_grader_required",409);
  const release=pin.release??{id:compiled.id,revision:Number(compiled.version),contentHash:contentHash(compiled)};
  return {evidence:HumanEvidenceSchema.parse({dataset,grader:release,graderBinding:{id:compiled.id,version:compiled.version,contentHash:contentHash(compiled)},rubric:{id:compiled.rubricRef.id,revision:1,contentHash:compiled.rubricRef.contentHash},attempts:[],taskIds}),form:HumanFormSchema.parse(compiled.form)};
}
