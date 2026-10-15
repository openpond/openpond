import { useState, type ReactNode } from "react";
import type { ChatResourceSummary, ChatContextSelection } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { DatasetRowPreview } from "./DatasetRowPreview";

export function TrainingWorkspaceSection({ title, children, open = false, onOpenChange }: { title: string; children: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  return <details className="training-workspace-section" open={open} onToggle={event => onOpenChange?.(event.currentTarget.open)}>
    <summary>{title}</summary>
    <div className="training-workspace-section-content">{children}</div>
  </details>;
}

export function ChatTrainingInputs({ dataset, graders, model, connection }: {
  dataset?: ChatResourceSummary | null; graders: ChatResourceSummary[]; model?: ChatContextSelection["model"]; connection?: ClientConnection;
}) {
  const [datasetOpen, setDatasetOpen] = useState(false);
  const configured = model ? [
    { role: "Training", dataset: model.trainingDataset }, { role: "Evaluation", dataset: model.evaluationDataset },
  ].filter(item => item.dataset) : [];
  return <>
    <TrainingWorkspaceSection title="Dataset" open={datasetOpen} onOpenChange={setDatasetOpen}>
      <div className="training-table-wrap"><table className="training-data-table evaluation-workspace-table">
        <thead><tr>{model ? <th>Use</th> : null}<th>Dataset</th><th>Revision</th>{!model ? <th>Examples</th> : null}</tr></thead>
        <tbody>{model ? configured.map(item => <tr key={item.role}><td>{item.role}</td><td>{item.dataset!.name}</td><td>{item.dataset!.revision}</td></tr>)
          : dataset ? <tr><td>{dataset.name}</td><td>{dataset.revision}</td><td>{dataset.taskCount ?? "—"}</td></tr> : null}</tbody>
      </table></div>
      {datasetOpen && dataset && connection && !model ? <DatasetRowPreview key={`${dataset.id}:${dataset.revision}`} connection={connection} dataset={dataset} /> : null}
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
