import type { ChatExperimentView } from "./chat-cloud-experiments.js";
import { REPORT_STYLE, REPORT_TABS_SCRIPT } from "./chat-experiment-report-presentation.js";
import { localExperimentView } from "./chat-experiments.js";
import type { ChatResourceSummary, LocalExperimentResult } from "@openpond/contracts";

const escape = (value:string) => value.replace(/[&<>"']/g,character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[character]!));
const percent = (value:number|null|undefined) => value == null ? "Unavailable" : (value*100).toFixed(1)+"%";
const cost = (value:number|null|undefined) => value == null ? "Unavailable" : "$"+value.toFixed(4);

/** A report is a view of exact retained evidence. Text is escaped, missing
 * measurements stay missing, and the document has no executable app actions. */
export function chatExperimentReport(runs:{summary:ChatResourceSummary;evidence?:LocalExperimentResult;view?:ChatExperimentView}[]) {
  if (!runs.length || runs.length > 8) throw new Error("A report requires one to eight retained runs.");
  let remainingText=7000;
  const display=(value:string,limit=120)=>{const length=Math.min(limit,remainingText);remainingText-=Math.min(value.length,length);return escape(value.slice(0,length)+(value.length>length ? "…" : ""));};
  const retained=runs.map(run=>({...run,view:run.view ?? localExperimentView(run.evidence!)}));
  const comparable = new Set(retained.map(run=>JSON.stringify({dataset:run.summary.datasetId,revision:run.summary.datasetRevision,
    population:run.view.cases.map(row=>[row.taskId,row.seed]),graders:run.view.graders,scope:run.view.scope,metric:run.summary.scoreLabel ?? "Mean task score"}))).size === 1;
  // Reserve the text allowance for exact retained identifiers before shortening
  // model labels and representative output. Large cases must not hide the pins.
  const pins = retained.map(({summary,view})=>'<li>'+display(summary.id,200)+' · Dataset '+display(summary.datasetId ?? "",200)+' version '+(summary.datasetRevision ?? "")+' · retained result '+display(view.contentHash,200)+'</li>').join("");
  const runLabel = (summary:ChatResourceSummary)=>'<span class="run-label">'+display(summary.name,160)+'<small>'+display(summary.model ?? "Selected model")+' · Dataset version '+(summary.datasetRevision ?? "Unavailable")+' · run '+display(summary.id.slice(-8),8)+'</small></span>';
  const rows = retained.map(({summary})=>{
    const quality = summary.qualityFailureCount ?? 0;
    const infrastructure = summary.executionFailureCount ?? 0;
    const unavailable = summary.ungradedCount ?? summary.taskCount ?? 0;
    return '<tr><th scope="row">'+runLabel(summary)+'</th><td>'+escape(summary.state)+'</td><td>'+percent(summary.score)+'<small> · '+display(summary.scoreLabel ?? "Mean task score")+'</small>'+'</td><td>'+(summary.evaluatedCount ?? 0)+'/'+(summary.taskCount ?? 0)+'</td><td>'+quality+'</td><td>'+infrastructure+'</td><td>'+unavailable+'</td><td>'+cost(summary.costUsd)+'</td></tr>';
  }).join("");
  const bars = retained.map(({summary})=>'<div class="bar-row">'+runLabel(summary)+'<div class="track">'+(summary.score==null ? '<span>Unavailable</span>' : '<div class="bar" style="width:'+Math.max(0,Math.min(100,summary.score*100))+'%"></div>')+'</div><strong>'+percent(summary.score)+'</strong></div>').join("");
  const cases = retained.flatMap(({summary,view})=>view.cases.slice(0,3).map(row=>'<tr><td>'+runLabel(summary)+'</td><td>'+display(row.taskId)+'</td><td>'+display(row.error ?? row.output ?? row.status,300)+'</td><td>'+percent(row.score)+'</td></tr>')).join("");
  const comparison = comparable
    ? 'The selected runs share Dataset version, tasks, seeds and grader selection. Incomplete runs show a partial snapshot and cannot establish a final ranking.'
    : 'These runs have different inputs or grading selections; the table is descriptive and does not establish a winner.';
  return `<style>${REPORT_STYLE}</style>
<section class="experiment-report" aria-labelledby="report-heading">
  <h2 id="report-heading">Experiment results</h2>
  <div class="report-tabs" role="tablist" aria-label="Experiment results">
    <button type="button" role="tab" id="report-tab-overview" aria-controls="report-overview" aria-selected="true" tabindex="0">Overview</button>
    <button type="button" role="tab" id="report-tab-cases" aria-controls="report-cases" aria-selected="false" tabindex="-1">Cases</button>
    <button type="button" role="tab" id="report-tab-inputs" aria-controls="report-inputs" aria-selected="false" tabindex="-1">Saved inputs</button>
  </div>
  <div id="report-overview" role="tabpanel" aria-labelledby="report-tab-overview" tabindex="0">
    <p>Saved score (0–100%). Each run uses the metric named below; local runs show mean graded task score. Scores require complete grading; costs require measured usage. Quality failures are separate from execution failures. ${comparison}</p>
    <div class="chart" role="img" aria-label="Saved score by retained experiment">${bars}</div>
    <div class="table-wrap"><table class="summary"><thead><tr><th>Experiment</th><th>Status</th><th>Score</th><th>Graded / tasks</th><th>Quality failures</th><th>Execution failures</th><th>Ungraded</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table></div>
  </div>
  <div id="report-cases" role="tabpanel" aria-labelledby="report-tab-cases" tabindex="0" hidden>
    <p>At most three retained outcomes per run. Long labels and outcomes are shortened; full evidence remains in View results.</p>
    <div class="table-wrap"><table class="cases"><thead><tr><th>Experiment</th><th>Task</th><th>Outcome</th><th>Task score</th></tr></thead><tbody>${cases}</tbody></table></div>
  </div>
  <div id="report-inputs" role="tabpanel" aria-labelledby="report-tab-inputs" tabindex="0" hidden>
    <p>Exact Dataset versions and retained result identities used in this report.</p>
    <ul>${pins}</ul>
  </div>
</section>
<script>${REPORT_TABS_SCRIPT}</script>`;
}
