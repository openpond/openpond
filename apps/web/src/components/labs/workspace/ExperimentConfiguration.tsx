import type { ExperimentDefinition, ExperimentDefinitionRef, ExperimentScoringPass } from "openpond-sdk/experiments";
import type { ModelTasksetRunDetails } from "openpond-sdk/model-taskset-runs";
import { EvaluationCard, EvaluationModel } from "./EvaluationPresentation";

export function ExperimentConfiguration({ saved, execution, executedRef, retained, pass }: {
  saved: ExperimentDefinition | null; execution: ModelTasksetRunDetails | null;
  executedRef: ExperimentDefinitionRef | null; retained: ExperimentDefinition | null;
  pass: ExperimentScoringPass | null;
}) {
  const request = execution?.request ?? saved?.request;
  if (!request) return <p role="status">Loading exact configuration…</p>;
  const policy = request.policy;
  const model = "modelId" in policy ? policy.modelId : null;
  const graders = (execution ? retained?.graders : saved?.graders)?.map(grader => `${grader.feedbackKey} · ${grader.id} · ${grader.version}`);
  const budget = execution ? execution.manifest.limits.maximumSpendUsd : saved?.maximumCostUsd;
  return <><EvaluationCard title={execution ? "Selected execution configuration" : "Saved setup"}>
    <dl className="evaluation-workspace-meta">
      {execution ? <><dt>Execution</dt><dd>{execution.summary.id}</dd><dt>Manifest hash</dt><dd>{execution.summary.manifestHash}</dd><dt>Setup revision</dt><dd>{executedRef?.revision ?? "Unknown"} · {executedRef?.contentHash ?? "Unknown"}</dd></> : null}
      <dt>Dataset</dt><dd>{request.taskset.id} · Revision {request.taskset.revision}</dd>
      <dt>Dataset hash</dt><dd>{request.taskset.contentHash}</dd>
      <dt>Budget</dt><dd>{budget === null || budget === undefined ? "Unknown" : `$${budget}`} · Policy and graders combined</dd>
      <dt>Target</dt><dd><EvaluationModel name={model ?? "Authored fixture"} /></dd>
      <dt>Population</dt><dd>{request.population.length} cases</dd>
      <dt>Graders</dt><dd>{graders?.join("; ") ?? "Loading retained grader pins…"}</dd>
      <dt>Project</dt><dd>{request.project ? `${request.project.id} · Revision ${request.project.revision} · ${request.project.contentHash}` : "All projects"}</dd>
      <dt>Source</dt><dd>{policy.kind === "hosted_harness" ? `${policy.source.definitionId} · ${policy.source.sourceRevision}` : policy.kind === "hosted_chat" ? "Hosted model" : "Authored fixtures"}</dd>
      <dt>Execution location</dt><dd>Hosted</dd>
    </dl>
    {policy.kind === "hosted_chat" ? <details><summary>Model parameters and instructions</summary><pre>{JSON.stringify({ maxOutputTokens: policy.maxOutputTokens, temperature: policy.temperature, topP: policy.topP, messages: policy.messages ?? [] }, null, 2)}</pre></details> : null}
    {retained ? <p>{retained.request.name} · Retained setup revision {retained.revision}</p> : null}
  </EvaluationCard>{pass ? <EvaluationCard title="Selected scoring pass configuration">
    <dl className="evaluation-workspace-meta"><dt>Scoring pass</dt><dd>{pass.id}</dd><dt>Pass hash</dt><dd>{pass.contentHash}</dd><dt>Retained execution</dt><dd>{pass.request.execution.id} · {pass.request.execution.contentHash}</dd><dt>Grading budget</dt><dd>${pass.request.maximumCostUsd}</dd><dt>Graders</dt><dd>{pass.graders.map(grader => `${grader.feedbackKey} · ${grader.release!.id} · Revision ${grader.release!.revision} · ${grader.release!.contentHash}`).join("; ")}</dd></dl>
    <details><summary>Scoring field mappings</summary><pre>{JSON.stringify(pass.request.mappings ?? [], null, 2)}</pre></details>
  </EvaluationCard> : null}{execution && saved ? <EvaluationCard title="Current saved setup"><p>Revision {saved.revision} · {saved.contentHash}</p><p>{saved.request.name} · {"modelId" in saved.request.policy ? saved.request.policy.modelId : "Authored fixture"}</p><p>Dataset revision {saved.request.taskset.revision} · ${saved.maximumCostUsd} execution budget</p></EvaluationCard> : null}</>;
}
