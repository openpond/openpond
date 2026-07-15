import type { CrossSystemFrontierBaselineRun, TaskMinerConfig, TaskMinerRun } from "@openpond/contracts";
import { Loader2 } from "../icons";

export function TrainingAutomaticScopeStep({
  chatCount,
  frontierBaselineRun,
  frontierBaselineModel,
  frontierBaselineProject,
  frontierBaselineRunning,
  config,
  estimate,
  onConfigChange,
  onCancel,
  onCancelFrontierBaseline,
  onRunFrontierBaseline,
  onScan,
  run,
  scanning,
}: {
  chatCount: number;
  frontierBaselineRun: CrossSystemFrontierBaselineRun | null;
  frontierBaselineModel: string;
  frontierBaselineProject: string | null;
  frontierBaselineRunning: boolean;
  config: TaskMinerConfig;
  estimate: { messageCount: number; estimatedTokens: number; measuredChats: number };
  onConfigChange: (config: TaskMinerConfig) => void;
  onCancel: () => void;
  onCancelFrontierBaseline: () => void;
  onRunFrontierBaseline: () => void;
  onScan: () => void;
  run: TaskMinerRun | null;
  scanning: boolean;
}) {
  const frontierBaseline = frontierBaselineRun?.result ?? null;
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
            <p>Run {frontierBaselineModel} against 15 bounded tasks across train, validation, and frozen-evaluation worlds. Evidence chats are attached to {frontierBaselineProject ?? "the imported Cross-System Operations project"}; prompts and synthetic tool results are disclosed to the selected model provider.</p>
          </div>
          <div className="training-frontier-baseline-actions">
            {frontierBaselineRunning ? <button className="training-button secondary" type="button" disabled={frontierBaselineRun?.status === "cancelling"} onClick={onCancelFrontierBaseline}>
              {frontierBaselineRun?.status === "cancelling" ? "Cancelling…" : "Cancel baseline"}
            </button> : <button className="training-button secondary" type="button" disabled={scanning || !frontierBaselineProject} onClick={onRunFrontierBaseline}>
              {frontierBaseline ? "Run frontier baseline again" : "Run frontier baseline"}
            </button>}
          </div>
          {!frontierBaselineProject ? <p className="training-frontier-baseline-note error">Import the Cross-System Operations Agent SDK project through Make Agent before running this proof.</p> : null}
          {frontierBaselineRun && frontierBaselineRunning ? <div className="training-frontier-baseline-progress" role="status">
            <div><strong>{frontierStageLabel(frontierBaselineRun)}</strong><span>{frontierBaselineRun.progress.completedTasks} of {frontierBaselineRun.progress.totalTasks} tasks</span></div>
            <progress max={Math.max(1, frontierBaselineRun.progress.totalTasks)} value={frontierBaselineRun.progress.completedTasks} />
            {frontierBaselineRun.progress.currentTask ? <small>{label(frontierBaselineRun.progress.currentTask.family)} · {frontierBaselineRun.progress.currentTask.worldId}</small> : null}
          </div> : null}
          {frontierBaselineRun?.status === "failed" ? <p className="training-frontier-baseline-note error">Baseline failed: {frontierBaselineRun.error}</p> : null}
          {frontierBaselineRun?.status === "cancelled" ? <p className="training-frontier-baseline-note">Baseline cancelled after {frontierBaselineRun.progress.completedTasks} recorded tasks. Completed evidence chats were preserved.</p> : null}
          {frontierBaselineRun?.reboundSessionCount ? <p className="training-frontier-baseline-note">Moved {frontierBaselineRun.reboundSessionCount} earlier baseline chats into {frontierBaselineRun.localProjectName}.</p> : null}
          {frontierBaseline ? <dl className="training-frontier-baseline-results" aria-label="Frontier baseline results">
            <div><dt>Exact match</dt><dd>{Math.round(frontierBaseline.report.exactMatchAccuracy * 100)}%</dd></div>
            <div><dt>Tool calls</dt><dd>{frontierBaseline.report.metrics.toolCalls}</dd></div>
            <div><dt>Rows / bytes</dt><dd>{frontierBaseline.report.metrics.rowsRead} / {formatBytes(frontierBaseline.report.metrics.bytesRead)}</dd></div>
            <div><dt>Parse failures</dt><dd>{frontierBaseline.report.metrics.parseFailures}</dd></div>
            <div><dt>Wall time</dt><dd>{formatDuration(frontierBaseline.report.metrics.wallTimeMs)}</dd></div>
            <div><dt>Reward variance</dt><dd>{frontierBaseline.report.reward.variance.toFixed(4)}</dd></div>
            <div><dt>Approved traces</dt><dd>{frontierBaseline.bootstrap.length}</dd></div>
            <div><dt>Infrastructure failures</dt><dd>{frontierBaselineRun?.progress.outcomes.infrastructureFailure ?? 0}</dd></div>
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
          <div><strong>{minerStageLabel(run)}</strong><span>{run.progress.processedSources} of {run.progress.totalSources || chatCount} chats · {run.progress.candidatesFound} candidates{run.progress.skippedSources ? ` · ${run.progress.skippedSources} skipped` : ""}</span></div>
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

function frontierStageLabel(run: CrossSystemFrontierBaselineRun): string {
  if (run.status === "queued") return "Preparing baseline";
  if (run.status === "cancelling") return "Cancelling baseline";
  if (run.progress.stage === "preparing") return "Binding project evidence";
  if (run.progress.stage === "persisting") return "Saving baseline report";
  return "Running provider tool loop";
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

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  const seconds = milliseconds / 1_000;
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}
