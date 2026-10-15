import type { ReactNode } from "react";
import type { ChatResourceSummary, ChatContextSelection } from "@openpond/contracts";

export function TrainingWorkspaceSection({ title, children, open = false }: { title: string; children: ReactNode; open?: boolean }) {
  return <details className="training-workspace-section" open={open}>
    <summary>{title}</summary>
    <div className="training-workspace-section-content">{children}</div>
  </details>;
}

export function ChatTrainingInputs({ dataset, graders, model }: {
  dataset?: ChatResourceSummary | null; graders: ChatResourceSummary[]; model?: ChatContextSelection["model"];
}) {
  const configured = model ? [
    { role: "Training", dataset: model.trainingDataset }, { role: "Evaluation", dataset: model.evaluationDataset },
  ].filter(item => item.dataset) : [];
  return <>
    <TrainingWorkspaceSection title="Dataset">
      <div className="training-table-wrap"><table className="training-data-table evaluation-workspace-table">
        <thead><tr>{model ? <th>Use</th> : null}<th>Dataset</th><th>Revision</th>{!model ? <th>Examples</th> : null}</tr></thead>
        <tbody>{model ? configured.map(item => <tr key={item.role}><td>{item.role}</td><td>{item.dataset!.name}</td><td>{item.dataset!.revision}</td></tr>)
          : dataset ? <tr><td>{dataset.name}</td><td>{dataset.revision}</td><td>{dataset.taskCount ?? "—"}</td></tr> : null}</tbody>
      </table></div>
      {model ? <p className="chat-context-note">Model configuration. Each training run retains its own input snapshot.</p> : null}
      {!dataset && !configured.length ? <p>No dataset configured.</p> : null}
    </TrainingWorkspaceSection>
    <TrainingWorkspaceSection title="Graders">
      {graders.length ? <div className="training-table-wrap"><table className="training-data-table evaluation-workspace-table">
        <thead><tr><th>Grader</th><th>Type</th><th>Checks</th></tr></thead>
        <tbody>{graders.map(grader => <tr key={grader.id}><td>{grader.name}</td><td>{grader.graderType ?? "—"}</td><td>{grader.checkState ?? grader.state}</td></tr>)}</tbody>
      </table></div> : <p>{model ? "Inspect the model’s training dataset for its grader definitions." : "No graders configured for this dataset revision."}</p>}
    </TrainingWorkspaceSection>
  </>;
}
