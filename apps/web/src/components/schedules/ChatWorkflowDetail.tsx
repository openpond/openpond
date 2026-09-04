import type { PointerEvent as ReactPointerEvent } from "react";
import type { ChatWorkflow, ChatWorkflowRun } from "@openpond/contracts";
import { Pause, Play, RotateCcw, Trash2 } from "../icons";
import { DetailField, DetailSection, ScheduleDetailPanel } from "./ScheduledWorkDetailParts";
import { capitalize, formatScheduledRunAt } from "./scheduledWorkFormatting";
import { recurrenceCadence } from "./chatWorkflowFormatting";

export function ChatWorkflowDetail({
  detailExpanded,
  onClose,
  onDelete,
  onDetailResizeStart,
  onRun,
  onToggle,
  onToggleDetailExpanded,
  pending,
  runs,
  workflow,
}: {
  detailExpanded: boolean;
  onClose: () => void;
  onDelete: () => Promise<void>;
  onDetailResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onRun: () => Promise<void>;
  onToggle: () => Promise<void>;
  onToggleDetailExpanded: () => void;
  pending: boolean;
  runs: ChatWorkflowRun[];
  workflow: ChatWorkflow;
}) {
  return (
    <ScheduleDetailPanel
      detailExpanded={detailExpanded}
      label={`${workflow.name} details`}
      onClose={onClose}
      onDetailResizeStart={onDetailResizeStart}
      onToggleDetailExpanded={onToggleDetailExpanded}
    >
      <div className="scheduled-detail-header">
        <div>
          <div className="scheduled-detail-title-row">
            <h2>Workflow details</h2>
            <span>{workflow.enabled ? "Active" : "Paused"}</span>
          </div>
          <p>{workflow.name}</p>
        </div>
      </div>
      <DetailSection title="Prompt">
        <pre className="scheduled-prompt">{workflow.prompt}</pre>
      </DetailSection>
      <DetailSection title="Delivery">
        <dl className="scheduled-detail-fields">
          <DetailField label="Runs in" value={workflow.sessionTitle} />
          <DetailField label="Cadence" value={recurrenceCadence(workflow.recurrence)} />
          <DetailField label="Next run" value={formatScheduledRunAt(workflow.nextRunAt, workflow.recurrence.timeZone)} />
          <DetailField label="Last run" value={formatScheduledRunAt(workflow.lastRunAt, workflow.recurrence.timeZone)} />
        </dl>
        {workflow.lastError ? <p className="scheduled-detail-error">{workflow.lastError}</p> : null}
      </DetailSection>
      <div className="scheduled-detail-actions">
        <button disabled={pending} onClick={() => void onRun()} type="button"><RotateCcw size={15} /><span>Run now</span></button>
        <button disabled={pending} onClick={() => void onToggle()} type="button">
          {workflow.enabled ? <Pause size={15} /> : <Play size={15} />}
          <span>{workflow.enabled ? "Pause" : "Resume"}</span>
        </button>
        <button disabled={pending} onClick={() => void onDelete()} type="button"><Trash2 size={15} /><span>Delete</span></button>
      </div>
      <DetailSection title="Runs">
        {runs.length === 0 ? <p className="scheduled-no-runs">No runs yet.</p> : (
          <div className="scheduled-run-list">
            {runs.map((run) => (
              <div className="scheduled-run-row" key={run.id}>
                <span>{capitalize(run.status)}</span>
                <small>{formatScheduledRunAt(run.createdAt, workflow.recurrence.timeZone)}</small>
                {run.error ? <p>{run.error}</p> : null}
              </div>
            ))}
          </div>
        )}
      </DetailSection>
    </ScheduleDetailPanel>
  );
}
