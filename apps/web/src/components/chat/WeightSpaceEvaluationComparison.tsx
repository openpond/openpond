import { useState } from "react";
import type { WeightSpaceCommandResult } from "openpond-sdk/training";
import { DropdownSelect } from "../DropdownSelect";
import { WeightSpaceEvaluationOutput } from "./WeightSpaceEvaluationOutput";
type Evaluation=NonNullable<WeightSpaceCommandResult["evaluation"]>;
/** Compare only exact prompt/sampling peers. No held-out score or inferred
 * improvement is manufactured from the agent's generated text. */
export function WeightSpaceEvaluationComparison({results}:{results:WeightSpaceCommandResult[]}){
  const evaluations=results.flatMap(result=>result.status==="succeeded"&&result.evaluation?[{result,evaluation:result.evaluation}]:[]);
  const [baselineId,setBaselineId]=useState(""),[candidateId,setCandidateId]=useState("");
  const baseline=evaluations.find(row=>row.result.operationId===baselineId)??evaluations[0];
  function compatible(a:Evaluation,b:Evaluation){return a.panelId===b.panelId&&a.role===b.role&&a.sampling===b.sampling&&a.seed===b.seed
    &&a.rows.length===b.rows.length&&a.rows.every((row,index)=>row.id===b.rows[index]?.id&&row.inputHash===b.rows[index]?.inputHash);}
  const peers=baseline?evaluations.filter(row=>row.result.operationId!==baseline.result.operationId&&compatible(row.evaluation,baseline.evaluation)):[];
  const candidate=peers.find(row=>row.result.operationId===candidateId)??peers.at(-1);
  if(!baseline||!candidate)return null;
  const option=(row:(typeof evaluations)[number])=>({value:row.result.operationId,label:`Revision ${row.result.revision} · ${row.evaluation.panelId}`,description:`Candidate ${row.result.candidateHash.slice(0,12)}`});
  return <section className="training-detail-section" aria-label="Evaluation comparison"><h3>Compare evaluation outputs</h3>
    <DropdownSelect label="Baseline evaluation" value={baseline.result.operationId} options={evaluations.map(option)} onChange={value=>{setBaselineId(value);setCandidateId("");}}/>
    <DropdownSelect label="Candidate evaluation" value={candidate.result.operationId} options={peers.map(option)} onChange={setCandidateId}/>
    <p>{baseline.evaluation.role} · {baseline.evaluation.panelId} · identical prompts and greedy generation settings</p>
    {baseline.evaluation.rows.map((row,index)=><details key={row.id}><summary>{row.id}</summary>
      <WeightSpaceEvaluationOutput label={`Baseline · ${baseline.result.candidateHash.slice(0,12)}`} output={row}/>
      <WeightSpaceEvaluationOutput label={`Candidate · ${candidate.result.candidateHash.slice(0,12)}`} output={candidate.evaluation.rows[index]!}/>
    </details>)}
  </section>;
}
