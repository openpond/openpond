import { Fragment, useState } from "react";
import type { ProfileEvaluationDiscovery, ProfileWorkflowDiscovery } from "../../api";
import { displayScore, displayTimestamp, type EvaluationRun } from "./profile-evaluation-display";

export function ProfileWorkflowsSection({ catalog, evaluations, onEvaluate, onOpenRun, busy }: {
  catalog: ProfileWorkflowDiscovery;
  evaluations: ProfileEvaluationDiscovery | null;
  onEvaluate: (workflowId: string) => void;
  onOpenRun: (run: EvaluationRun) => void;
  busy: boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return <section className="profile-workflows" aria-label="Profile workflows">
    <div className="profile-workflows-header"><h3>Workflows</h3>
      <p>Open a workflow to review its instructions and linked evaluations.</p></div>
    {!catalog.workflows.length ? <p>No workflows in this Profile yet.</p> : <div className="profile-table-scroll">
      <table className="profile-evaluation-table"><thead><tr>
        <th scope="col">Workflow</th><th scope="col">Evaluations</th><th scope="col">Runs</th><th scope="col">Latest result</th><th scope="col">Actions</th>
      </tr></thead><tbody>{catalog.workflows.map(({ workflow, binding }) => {
        const definitions = evaluations?.definitions.filter(item => item.target.kind === "workflow" && item.target.workflowId === workflow.id) ?? [];
        const runs = evaluations?.runs.filter(item => item.manifest.profileEvaluation?.target.kind === "workflow"
          && item.manifest.profileEvaluation.target.workflowId === workflow.id) ?? [];
        const latest = runs[0];
        return <Fragment key={workflow.id}><tr>
          <th scope="row"><button type="button" aria-expanded={expandedId === workflow.id}
            onClick={() => setExpandedId(current => current === workflow.id ? null : workflow.id)}>{workflow.label}</button>
            <small>{workflow.description}</small></th>
          <td>{evaluations ? definitions.length : "—"}</td><td>{evaluations ? runs.length : "—"}</td>
          <td>{latest ? <button type="button" onClick={() => onOpenRun(latest)}>
            {latest.passed ? "Passed" : "Did not pass"} · {displayScore(latest.metric.value)}
            <small>{displayTimestamp(latest.completedAt)}</small></button> : "Not run"}</td>
          <td><button type="button" disabled={busy || !evaluations} onClick={() => onEvaluate(workflow.id)}>
            {definitions.length ? "Run Evaluation" : "View evaluations"}</button></td>
        </tr>{expandedId === workflow.id ? <tr><td colSpan={5}>
          <div className="profile-evaluations-detail">
            <strong>{workflow.label}</strong>
            <p>Revision {binding.sourceRevision.slice(0, 12)} · Release {binding.harnessRelease.contentHash.slice(0, 12)}</p>
            {workflow.skillPaths.length ? <p>Skills: {workflow.skillPaths.join(", ")}</p> : null}
            <details><summary>{workflow.invocation.kind === "instructions" ? "Instructions" : "Action configuration"}</summary>
              <pre>{workflow.invocation.kind === "instructions" ? workflow.invocation.instructions : JSON.stringify(workflow.invocation, null, 2)}</pre></details>
            <strong>Linked evaluations</strong>
            {definitions.length ? <ul>{definitions.map(item => <li key={item.id}>{item.label} · {item.taskIds.length} tasks · {item.seeds.length} seeds</li>)}</ul>
              : <p>{evaluations ? "No evaluation definition targets this workflow. Add one in the Profile’s evals catalog to run it." : "Evaluation catalog unavailable."}</p>}
            <button type="button" disabled={busy || !evaluations} onClick={() => onEvaluate(workflow.id)}>
              {definitions.length ? "Run Evaluation" : "View evaluation history"}</button>
          </div>
        </td></tr> : null}</Fragment>;
      })}</tbody></table>
    </div>}
  </section>;
}
