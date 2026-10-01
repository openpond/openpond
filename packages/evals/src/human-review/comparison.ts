import {z} from 'zod';
import {contentHash,ImmutableReleaseRefSchema} from '@openpond/harness';
import {humanProjectionViewId,createExperimentManifest,createExperimentResult,verifyExperimentEvidence,experimentCaseKey,ExperimentManifestSchema,ExperimentResultSchema,type ExperimentCaseIdentity} from '../experiments.js';
import {ReviewReleaseSchema,type HumanReview,type HumanAttemptRefSchema} from './contracts.js';
import {acceptedHumanEvidence} from './handoff.js';
import {createHumanResultView,HumanResultViewSchema} from './results.js';
import {LearningDomainError} from '../learning/errors.js';
const Hash=z.string().regex(/^[a-f0-9]{64}$/),Id=z.string().min(1).max(240);
const Base={feedbackKey:Id,criterionId:Id};
export const HumanComparisonRuleSchema=z.discriminatedUnion('kind',[
 z.object({...Base,kind:z.literal('normalized_score'),minimum:z.number().finite(),maximum:z.number().finite(),passThreshold:z.number().min(0).max(1).optional()}).strict(),
 z.object({...Base,kind:z.literal('boolean')}).strict(),
 z.object({...Base,kind:z.literal('category')}).strict(),
 z.object({...Base,kind:z.literal('preference_score'),tieScore:z.number().min(0).max(1).nullable()}).strict(),
]);
const Lane=z.object({execution:ImmutableReleaseRefSchema,resultHash:Hash,reviews:z.array(z.object({review:ReviewReleaseSchema,decision:ReviewReleaseSchema}).strict()).min(1).max(10000)}).strict();
export const HumanComparisonSelectionsSchema=z.object({rules:z.array(HumanComparisonRuleSchema).min(1).max(100),baseline:Lane,candidate:Lane}).strict().superRefine((v,c)=>{if(new Set(v.rules.map(r=>r.feedbackKey)).size!==v.rules.length)c.addIssue({code:'custom',message:'Select each Human feedback key once.'});});
export type HumanComparisonSelections=z.infer<typeof HumanComparisonSelectionsSchema>;
const Evidence=z.object({manifest:ExperimentManifestSchema,result:ExperimentResultSchema}).strict();
const Source=z.object({id:Id,manifestHash:Hash,resultHash:Hash}).strict();
const ReceiptContent=z.object({schemaVersion:z.literal('openpond.humanComparisonProjection.v1'),teamId:Id,projectId:Id,selections:HumanComparisonSelectionsSchema,original:z.object({baseline:Source,candidate:Source}).strict(),humanResults:z.object({baseline:HumanResultViewSchema,candidate:HumanResultViewSchema}).strict(),baseline:Evidence,candidate:Evidence}).strict();
export const HumanComparisonProjectionSchema=ReceiptContent.extend({contentHash:Hash}).strict();
export type HumanComparisonProjection=z.infer<typeof HumanComparisonProjectionSchema>;
function fail(code:string):never{throw new LearningDomainError(code,409);}
type Attempt=z.infer<typeof HumanAttemptRefSchema>;
type Input={teamId:string;projectId:string;baseline:z.infer<typeof Evidence>;candidate:z.infer<typeof Evidence>;selections:HumanComparisonSelections;authorize():Promise<void>;readReview(ref:z.infer<typeof ReviewReleaseSchema>):Promise<HumanReview>;caseIdentity(attempt:Attempt):Promise<ExperimentCaseIdentity>};
/** The host supplies current resource/subject owners and real retained receipt
 * identities. This creates another evidence view; it never changes a pass. */
export async function projectAcceptedHumanComparison(input:Input):Promise<HumanComparisonProjection>{
 const selections=HumanComparisonSelectionsSchema.parse(input.selections);await input.authorize();
 const sources={baseline:verifyExperimentEvidence(input.baseline),candidate:verifyExperimentEvidence(input.candidate)};
 const expectedExecutions=new Set([selections.baseline.execution.id,selections.candidate.execution.id]);if(expectedExecutions.size!==2)fail("human_comparison_distinct_executions_required");let acceptedBytes=0;
 async function lane(kind:'baseline'|'candidate'){
  const source=sources[kind],selection=selections[kind],execution=source.manifest.lineage?.execution;
  if(source.manifest.lineage?.humanProjection)fail('human_comparison_recursive_projection');
  if(!execution||contentHash(execution)!==contentHash(selection.execution)||source.manifest.teamId!==input.teamId)fail('human_comparison_execution_changed');
  const reviews:HumanReview[]=[];
  const projected=new Map<string,{review:HumanReview;accepted:ReturnType<typeof acceptedHumanEvidence>;attempt:Attempt}>();
  for(const selected of selection.reviews){
   const review=await input.readReview(selected.review);
   if(review.scope!==input.teamId||review.projectId!==input.projectId||review.kind!=='grade'||review.revision!==selected.review.revision||review.id!==selected.review.id)fail('human_comparison_review_scope_changed');
   const accepted=acceptedHumanEvidence(review,{reviewHash:selected.review.contentHash,decisionHash:selected.decision.contentHash});acceptedBytes+=new TextEncoder().encode(JSON.stringify({answers:accepted.answers,form:review.form})).byteLength;if(acceptedBytes>4_194_304)fail('human_comparison_projection_too_large');
   if(contentHash(accepted.decision)!==contentHash(selected.decision))fail('human_comparison_decision_changed');
   if(review.evidence.attempts.some(a=>!expectedExecutions.has(a.experimentId)))fail('human_comparison_foreign_attempt');
   const attempts=review.evidence.attempts.filter(a=>a.experimentId===execution.id);
   if(attempts.length!==1)fail('human_comparison_attempt_ambiguous');
   const attempt=attempts[0]!,identity=await input.caseIdentity(attempt),row=source.result.cases.find(r=>experimentCaseKey(r.identity)===experimentCaseKey(identity));
   if(!row||identity.caseId!==attempt.taskId||!row.traceRef||row.traceRef.contentHash!==attempt.trace?.contentHash||row.output===null)fail('human_comparison_receipt_changed');
   const key=experimentCaseKey(identity)+':'+review.evidence.grader.id;
   if(projected.has(key))fail('human_comparison_duplicate_assessment');
   projected.set(key,{review,accepted,attempt});reviews.push(review);
  }
  const resultView=createHumanResultView({executionId:execution.id,executionHash:execution.contentHash,reviews});
  if(resultView.contentHash!==selection.resultHash||resultView.coverage.accepted!==reviews.length)fail('human_comparison_result_changed');
  const evaluatorRules=new Map(selections.rules.map(rule=>[rule.feedbackKey,rule]));
  const evaluators=source.manifest.evaluators.map(evaluator=>{
   const rule=evaluatorRules.get(evaluator.feedbackKey);if(!rule)return evaluator;
   const forms=reviews.filter(r=>r.evidence.grader.id===evaluator.release.id&&String(r.evidence.grader.revision)===String(evaluator.release.revision)&&r.evidence.grader.contentHash===evaluator.release.contentHash).map(r=>r.form);
   if(!forms.length||new Set(forms.map(contentHash)).size!==1)fail('human_comparison_form_changed');
   const criterion=forms[0]!.criteria.find(c=>c.id===rule.criterionId);if(!criterion)fail('human_comparison_criterion_unavailable');
   if(rule.kind==='normalized_score'&&(criterion.kind!=='score'||rule.minimum!==criterion.minimum||rule.maximum!==criterion.maximum||rule.maximum<=rule.minimum)||rule.kind==='boolean'&&criterion.kind!=='boolean'||rule.kind==='category'&&criterion.kind!=='category'||rule.kind==='preference_score'&&(criterion.kind!=='preference'||forms[0]!.mode!=='pairwise'))fail('human_comparison_rule_changed');
   return {...evaluator,output:rule.kind==='boolean'?'boolean' as const:rule.kind==='category'?'category' as const:'score' as const,categories:criterion.kind==='category'?criterion.options:[],configurationHash:contentHash({original:evaluator.configurationHash,rule,formHash:contentHash(forms[0])})};
  });
  if(selections.rules.some(rule=>!source.manifest.evaluators.some(e=>e.feedbackKey===rule.feedbackKey)))fail('human_comparison_grader_unavailable');
  const {contentHash:_manifestHash,...manifestBody}=source.manifest;void _manifestHash;
  const projectionLineage={originalManifest:{id:source.manifest.id,contentHash:source.manifest.contentHash},selectionHash:contentHash(selection),rulesHash:contentHash(selections.rules)};
  const manifest=createExperimentManifest({...manifestBody,id:humanProjectionViewId(projectionLineage.originalManifest,projectionLineage.selectionHash,projectionLineage.rulesHash),lineage:{...source.manifest.lineage!,humanProjection:projectionLineage},evaluators});
  const cases=source.result.cases.map(row=>{
   const feedback=row.feedback.map(original=>{
    const rule=evaluatorRules.get(original.feedbackKey);if(!rule)return original;
    const found=projected.get(experimentCaseKey(row.identity)+':'+original.evaluator.id);
    if(!found||found.review.evidence.grader.contentHash!==original.evaluator.contentHash)fail('human_comparison_assessment_missing');
    const answer=found.accepted.answers.find(a=>a.criterionId===rule.criterionId);let value:number|boolean|string|null=null;
    if(answer&&!answer.abstain){
     if(rule.kind==='normalized_score'&&typeof answer.value==='number')value=(answer.value-rule.minimum)/(rule.maximum-rule.minimum);
     if(rule.kind==='boolean'&&typeof answer.value==='boolean')value=answer.value;
     if(rule.kind==='category'&&typeof answer.value==='string')value=answer.value;
     if(rule.kind==='preference_score'){const slot=found.review.evidence.attempts.findIndex(a=>a.experimentId===execution.id&&a.attemptId===found.attempt.attemptId);value=answer.value==='tie'?rule.tieScore:answer.value==='A'||answer.value==='B'?(answer.value===(slot===0?'A':'B')?1:0):null;}
    }
    return {...original,status:value===null?'unavailable' as const:'scored' as const,value,passed:value===null?null:rule.kind==='boolean'?value as boolean:rule.kind==='normalized_score'&&rule.passThreshold!==undefined?Number(value)>=rule.passThreshold:null,reasoning:answer?.note??null,evidenceRefs:[{id:found.accepted.review.id,contentHash:found.accepted.review.contentHash,mediaType:'application/vnd.openpond.human-review+json',sizeBytes:null},{id:found.accepted.decision.id,contentHash:found.accepted.decision.contentHash,mediaType:'application/vnd.openpond.human-decision+json',sizeBytes:null}]};
   });
   const complete=row.output!==null&&feedback.every(f=>f.status==='scored');
   return {...row,feedback,status:complete?'completed' as const:row.status,error:complete?null:row.error};
  });
  const {contentHash:_resultHash,...resultBody}=source.result;void _resultHash;
  const result=createExperimentResult({...resultBody,manifest:{id:manifest.id,contentHash:manifest.contentHash},cases},manifest);
  // After all private reads, re-read every exact accepted revision through the
  // current host authority before returning a projection usable by adoption.
  for(const review of reviews){const current=await input.readReview({id:review.id,revision:review.revision,contentHash:review.contentHash});if(current.contentHash!==review.contentHash||current.status!=='accepted')fail('human_comparison_review_changed');}
  await input.authorize();return {evidence:{manifest,result},humanResult:resultView};
 }
 const baseline=await lane('baseline'),candidate=await lane('candidate');for(const ref of [...selections.baseline.reviews,...selections.candidate.reviews]){const current=await input.readReview(ref.review);if(current.contentHash!==ref.review.contentHash||current.status!=='accepted'||current.decisions.at(-1)?.contentHash!==ref.decision.contentHash)fail('human_comparison_review_changed');}await input.authorize();
 const original={baseline:{id:sources.baseline.manifest.id,manifestHash:sources.baseline.manifest.contentHash,resultHash:sources.baseline.result.contentHash},candidate:{id:sources.candidate.manifest.id,manifestHash:sources.candidate.manifest.contentHash,resultHash:sources.candidate.result.contentHash}};
 const body=ReceiptContent.parse({schemaVersion:'openpond.humanComparisonProjection.v1',teamId:input.teamId,projectId:input.projectId,selections,original,humanResults:{baseline:baseline.humanResult,candidate:candidate.humanResult},baseline:baseline.evidence,candidate:candidate.evidence});
 if(new TextEncoder().encode(JSON.stringify(body)).byteLength>8_388_608)fail('human_comparison_projection_too_large');return HumanComparisonProjectionSchema.parse({...body,contentHash:contentHash(body)});
}
export function verifyHumanComparisonProjection(raw:unknown, originals?:{baseline:z.infer<typeof Evidence>;candidate:z.infer<typeof Evidence>}){
 const value=HumanComparisonProjectionSchema.parse(raw),{contentHash:hash,...body}=value;if(hash!==contentHash(body))fail('human_comparison_projection_invalid');
 for(const kind of ['baseline','candidate'] as const){
  const evidence=verifyExperimentEvidence(value[kind]),lineage=evidence.manifest.lineage,projection=lineage?.humanProjection,original=value.original[kind],selection=value.selections[kind];
  if(!lineage||!projection||projection.originalManifest.id!==original.id||projection.originalManifest.contentHash!==original.manifestHash||projection.selectionHash!==contentHash(selection)||projection.rulesHash!==contentHash(value.selections.rules)||contentHash(lineage.execution)!==contentHash(selection.execution)||evidence.manifest.teamId!==value.teamId||value.humanResults[kind].contentHash!==selection.resultHash)fail('human_comparison_projection_lineage_changed');
  const {contentHash:humanHash,...humanBody}=value.humanResults[kind];if(contentHash(humanBody)!==humanHash||humanBody.executionId!==selection.execution.id||humanBody.executionHash!==selection.execution.contentHash||contentHash(humanBody.selection)!==contentHash(selection.reviews.map(ref=>ref.review)))fail('human_comparison_human_result_changed');
  if(originals){const actual=verifyExperimentEvidence(originals[kind]);if(actual.manifest.lineage?.humanProjection||actual.manifest.id!==original.id||actual.manifest.contentHash!==original.manifestHash||actual.result.contentHash!==original.resultHash||contentHash(actual.manifest.lineage?.execution)!==contentHash(selection.execution))fail('human_comparison_original_changed');}
 }
 return value;
}
