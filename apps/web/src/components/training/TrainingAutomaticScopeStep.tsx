import type { TaskMinerConfig, TaskMinerRun } from "@openpond/contracts";
import type { CrossSystemFrontierBaselineResult } from "../../hooks/useTraining";
import { Loader2 } from "../icons";

export function TrainingAutomaticScopeStep({
  chatCount,
  frontierBaseline,
  frontierBaselineModel,
  frontierBaselineRunning,
  config,
  estimate,
  onConfigChange,
  onCancel,
  onRunFrontierBaseline,
  onScan,
  run,
  scanning,
}: {
  chatCount: number;
  frontierBaseline: CrossSystemFrontierBaselineResult | null;
  frontierBaselineModel: string;
  frontierBaselineRunning: boolean;
  config: TaskMinerConfig;
  estimate: { messageCount: number; estimatedTokens: number; measuredChats: number };
  onConfigChange: (config: TaskMinerConfig) => void;
  onCancel: () => void;
  onRunFrontierBaseline: () => void;
  onScan: () => void;
  run: TaskMinerRun | null;
  scanning: boolean;
}) {
  return (
    <>
      <div className="training-dialog-scroll-body">
        <div className="training-run-step-heading">
          <h3>Find repeated work</h3>
          <p>The scan indexes and clusters eligible completed chats locally. No chat content is sent to the authoring model.</p>
        </div>
        <dl className="training-automatic-scope-summary">
          <div><dt>Chats in scope</dt><dd>{chatCount}</dd></div>
          <div><dt>Messages</dt><dd>{estimate.measuredChats === chatCount ? estimate.messageCount : "Estimating…"}</dd></div>
          <div><dt>Approximate tokens</dt><dd>{estimate.measuredChats === chatCount ? formatTokens(estimate.estimatedTokens) : "Estimating…"}</dd></div>
        </dl>
        <section className="training-frontier-baseline">
          <div>
            <h4>Cross-System Operations proof evidence</h4>
            <p>Run {frontierBaselineModel} against 15 bounded tasks across train, validation, and frozen-evaluation worlds. Tool traces stay local; prompts and synthetic tool results are disclosed to the selected model provider.</p>
          </div>
          <button className="training-button secondary" type="button" disabled={scanning || frontierBaselineRunning} onClick={onRunFrontierBaseline}>
            {frontierBaselineRunning ? <Loader2 className="spin" size={14} /> : null}
            {frontierBaselineRunning ? "Running frontier baseline…" : frontierBaseline ? "Run frontier baseline again" : "Run frontier baseline"}
          </button>
          {frontierBaseline ? <dl className="training-frontier-baseline-results" aria-label="Frontier baseline results">
            <div><dt>Exact match</dt><dd>{Math.round(frontierBaseline.report.exactMatchAccuracy * 100)}%</dd></div>
            <div><dt>Tool calls</dt><dd>{frontierBaseline.report.metrics.toolCalls}</dd></div>
            <div><dt>Rows / bytes</dt><dd>{frontierBaseline.report.metrics.rowsRead} / {formatBytes(frontierBaseline.report.metrics.bytesRead)}</dd></div>
            <div><dt>Parse failures</dt><dd>{frontierBaseline.report.metrics.parseFailures}</dd></div>
            <div><dt>Reward variance</dt><dd>{frontierBaseline.report.reward.variance.toFixed(4)}</dd></div>
            <div><dt>Approved traces</dt><dd>{frontierBaseline.bootstrap.length}</dd></div>
          </dl> : null}
        </section>
        <details className="training-automatic-options">
          <summary>Scan options</summary>
          <div>
            <label>Look back <input type="number" min={1} max={365} value={config.observationWindowDays} onChange={(event) => onConfigChange({ ...config, observationWindowDays: Number(event.target.value) })} /> days</label>
            <label>Minimum recurrence <input type="number" min={2} max={100} value={config.minimumRecurrence} onChange={(event) => onConfigChange({ ...config, minimumRecurrence: Number(event.target.value) })} /></label>
          </div>
        </details>
        {run && ["queued", "running", "cancelling"].includes(run.status) ? <div className="training-miner-progress" role="status">
          <div><strong>{minerStageLabel(run)}</strong><span>{run.progress.processedSources} of {run.progress.totalSources || chatCount} chats · {run.progress.candidatesFound} candidates</span></div>
          <progress max={Math.max(1, run.progress.totalSources || chatCount)} value={run.progress.processedSources} />
        </div> : null}
        {run?.status === "failed" ? <p className="training-empty">Scan failed: {run.error}</p> : null}
        {run?.status === "cancelled" ? <p className="training-empty">The scan was cancelled. No candidate was selected.</p> : null}
      </div>
      <div className="training-dialog-actions">
        {scanning ? <button className="training-button secondary" type="button" disabled={run?.status === "cancelling"} onClick={onCancel}>{run?.status === "cancelling" ? "Cancelling…" : "Cancel scan"}</button> : null}
        <button className="training-button" type="button" disabled={scanning || frontierBaselineRunning || (chatCount === 0 && !frontierBaseline)} onClick={onScan}>{scanning ? <Loader2 className="spin" size={14} /> : null}{scanning ? "Scanning…" : "Scan chats"}</button>
      </div>
    </>
  );
}

function minerStageLabel(run: TaskMinerRun): string {
  if (run.status === "queued") return "Preparing scan";
  if (run.status === "cancelling") return "Cancelling scan";
  if (run.progress.stage === "clustering") return "Clustering repeated work";
  if (run.progress.stage === "persisting") return "Saving candidates";
  return "Scanning local evidence";
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}K`;
  return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
