import type { TaskMinerConfig, TaskMinerRun } from "@openpond/contracts";
import { Loader2 } from "../icons";

export function TrainingAutomaticScopeStep({
  chatPreview,
  chatCount,
  config,
  estimate,
  onConfigChange,
  onCancel,
  onScan,
  run,
  scanning,
}: {
  chatPreview: Array<{ id: string; title: string; updatedAt: string }>;
  chatCount: number;
  config: TaskMinerConfig;
  estimate: { messageCount: number; estimatedTokens: number; measuredChats: number };
  onConfigChange: (config: TaskMinerConfig) => void;
  onCancel: () => void;
  onScan: () => void;
  run: TaskMinerRun | null;
  scanning: boolean;
}) {
  return (
    <>
      <div className="training-dialog-scroll-body">
        <div className="training-run-step-heading">
          <h3>Review chats in scope</h3>
          <p>OpenPond groups repeated work across completed chats on this device. The next step shows candidate workflows and their supporting chats; nothing is sent to an authoring model until you choose a candidate and approve disclosure.</p>
        </div>
        <dl className="training-automatic-scope-summary">
          <div><dt>Chats in scope</dt><dd>{chatCount}</dd></div>
          <div><dt>Messages</dt><dd>{estimate.measuredChats === chatCount ? estimate.messageCount : "Estimating…"}</dd></div>
          <div><dt>Approximate tokens</dt><dd>{estimate.measuredChats === chatCount ? formatTokens(estimate.estimatedTokens) : "Estimating…"}</dd></div>
        </dl>
        <section className="training-automatic-chat-preview" aria-label="Recent chats in scope">
          <div><h4>Recent chats</h4><span>Showing {chatPreview.length} of {chatCount}</span></div>
          {chatPreview.length ? <ul>{chatPreview.map((chat) => <li key={chat.id}><strong>{chat.title}</strong><time dateTime={chat.updatedAt}>{formatDate(chat.updatedAt)}</time></li>)}</ul> : <p>No completed chats are available yet.</p>}
          <small>Finding repeated work reads these chats locally. You will review the matching chats before any Taskset is authored.</small>
        </section>
        <details className="training-automatic-options">
          <summary>Search options</summary>
          <div>
            <label>Look back <input type="number" min={1} max={365} value={config.observationWindowDays} onChange={(event) => onConfigChange({ ...config, observationWindowDays: Number(event.target.value) })} /> days</label>
            <label>Minimum recurrence <input type="number" min={2} max={100} value={config.minimumRecurrence} onChange={(event) => onConfigChange({ ...config, minimumRecurrence: Number(event.target.value) })} /></label>
          </div>
        </details>
        {run && ["queued", "running", "cancelling"].includes(run.status) ? <div className="training-miner-progress" role="status">
          <div><strong>{minerStageLabel(run)}</strong><span>{run.progress.processedSources} of {run.progress.totalSources || chatCount} chats · {run.progress.candidatesFound} candidates{run.progress.skippedSources ? ` · ${run.progress.skippedSources} skipped` : ""}</span></div>
          <progress max={Math.max(1, run.progress.totalSources || chatCount)} value={run.progress.processedSources} />
        </div> : null}
        {run?.status === "failed" ? <p className="training-empty">Scan failed: {run.error}</p> : null}
        {run?.status === "cancelled" ? <p className="training-empty">The scan was cancelled. No candidate was selected.</p> : null}
      </div>
      <div className="training-dialog-actions">
        {scanning ? <button className="training-button secondary" type="button" disabled={run?.status === "cancelling"} onClick={onCancel}>{run?.status === "cancelling" ? "Cancelling…" : "Cancel scan"}</button> : null}
        <button className="training-button" type="button" disabled={scanning || chatCount === 0} onClick={onScan}>{scanning ? <Loader2 className="spin" size={14} /> : null}{scanning ? "Finding repeated work…" : "Find repeated work"}</button>
      </div>
    </>
  );
}

function minerStageLabel(run: TaskMinerRun): string {
  if (run.status === "queued") return "Preparing scan";
  if (run.status === "cancelling") return "Cancelling scan";
  if (run.progress.stage === "ingesting") return "Preparing local evidence";
  if (run.progress.stage === "clustering") return "Clustering repeated work";
  if (run.progress.stage === "persisting") return "Saving candidates";
  return "Scanning local evidence";
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}K`;
  return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}
