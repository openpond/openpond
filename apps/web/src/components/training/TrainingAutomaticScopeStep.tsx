import type {
  TaskMinerConfig,
  TaskMinerRun,
  TrainingChatSearchEntry,
} from "@openpond/contracts";
import { Loader2 } from "../icons";
import {
  formatTrainingTokens,
  TrainingChatPicker,
  type TrainingSourceEstimate,
} from "./TrainingChatPicker";

export function TrainingAutomaticScopeStep({
  config,
  estimatesBySessionId,
  estimate,
  matchingSessionCount,
  onCancel,
  onConfigChange,
  onLoadMore,
  onScan,
  onSearchChange,
  onToggleSession,
  onToggleVisible,
  run,
  scanning,
  search,
  searchError,
  searchHasMore,
  searchIndexedChats,
  searchIndexing,
  searchLoading,
  searchTotalChats,
  selectedEntries,
  selectedSessionIds,
  targetLabel,
  visibleSessions,
}: {
  config: TaskMinerConfig;
  estimatesBySessionId: Record<string, TrainingSourceEstimate>;
  estimate: TrainingSourceEstimate & { measuredChats: number };
  matchingSessionCount: number;
  onCancel: () => void;
  onConfigChange: (config: TaskMinerConfig) => void;
  onLoadMore: () => void;
  onScan: () => void;
  onSearchChange: (value: string) => void;
  onToggleSession: (sessionId: string, selected: boolean) => void;
  onToggleVisible: () => void;
  run: TaskMinerRun | null;
  scanning: boolean;
  search: string;
  searchError: string | null;
  searchHasMore: boolean;
  searchIndexedChats: number;
  searchIndexing: boolean;
  searchLoading: boolean;
  searchTotalChats: number;
  selectedEntries: TrainingChatSearchEntry[];
  selectedSessionIds: Set<string>;
  targetLabel: string;
  visibleSessions: TrainingChatSearchEntry[];
}) {
  const selectedCount = selectedSessionIds.size;
  const estimateComplete = estimate.measuredChats === selectedCount;
  const copy = automaticCopy(targetLabel);

  return (
    <>
      <div className="training-dialog-scroll-body">
        <div className="training-run-step-heading">
          <h3>Choose chats to inspect</h3>
          <p>{copy.description}</p>
        </div>
        <TrainingChatPicker
          disabled={scanning}
          estimatesBySessionId={estimatesBySessionId}
          matchingSessionCount={matchingSessionCount}
          onLoadMore={onLoadMore}
          onSearchChange={onSearchChange}
          onToggleSession={onToggleSession}
          onToggleVisible={onToggleVisible}
          search={search}
          searchError={searchError}
          searchHasMore={searchHasMore}
          searchIndexedChats={searchIndexedChats}
          searchIndexing={searchIndexing}
          searchLoading={searchLoading}
          searchTotalChats={searchTotalChats}
          selectedEntries={selectedEntries}
          selectedSessionIds={selectedSessionIds}
          visibleSessions={visibleSessions}
        />
        <p className="training-local-scope-note">
          The scan reads only the selected chats and runs locally. Nothing is sent to an authoring model until you choose a recommendation and approve its supporting chats.
        </p>
        <details className="training-automatic-options">
          <summary>Discovery options</summary>
          <div>
            <label>Look back <input type="number" min={1} max={365} value={config.observationWindowDays} onChange={(event) => onConfigChange({ ...config, observationWindowDays: Number(event.target.value) })} /> days</label>
            <label>Minimum recurrence <input type="number" min={2} max={100} value={config.minimumRecurrence} onChange={(event) => onConfigChange({ ...config, minimumRecurrence: Number(event.target.value) })} /></label>
          </div>
        </details>
        {run && ["queued", "running", "cancelling"].includes(run.status) ? (
          <div className="training-miner-progress" role="status">
            <div>
              <strong>{minerStageLabel(run)}</strong>
              <span>{run.progress.processedSources} of {run.progress.totalSources || selectedCount} chats · {run.progress.candidatesFound} candidates{run.progress.skippedSources ? ` · ${run.progress.skippedSources} skipped` : ""}</span>
            </div>
            <progress max={Math.max(1, run.progress.totalSources || selectedCount)} value={run.progress.processedSources} />
          </div>
        ) : null}
        {run?.status === "failed" ? <p className="training-empty">Scan failed: {run.error}</p> : null}
        {run?.status === "cancelled" ? <p className="training-empty">The scan was cancelled. No recommendation was selected.</p> : null}
      </div>
      <div className="training-dialog-actions">
        <span className="training-selection-count">
          {selectedCount === 0
            ? "Select one or more chats"
            : estimateComplete
              ? <>
                  <span>{selectedCount} chat{selectedCount === 1 ? "" : "s"}</span>
                  <span>{estimate.messageCount} messages</span>
                  <span>About {formatTrainingTokens(estimate.estimatedTokens)} tokens</span>
                </>
              : <><span>{selectedCount} chat{selectedCount === 1 ? "" : "s"}</span><span>Estimating…</span></>}
        </span>
        {scanning ? (
          <button className="training-button secondary" type="button" disabled={run?.status === "cancelling"} onClick={onCancel}>
            {run?.status === "cancelling" ? "Cancelling…" : "Cancel scan"}
          </button>
        ) : null}
        <button className="training-button" type="button" disabled={scanning || selectedCount === 0} onClick={onScan}>
          {scanning ? <Loader2 className="spin" size={14} /> : null}
          {scanning ? copy.scanningLabel : copy.actionLabel}
        </button>
      </div>
    </>
  );
}

function automaticCopy(targetLabel: string): {
  actionLabel: string;
  description: string;
  scanningLabel: string;
} {
  if (targetLabel === "agent") {
    return {
      actionLabel: "Find Agent opportunities",
      description: "Select completed chats that may contain repeated work worth turning into an Agent. OpenPond will compare only the chats you choose.",
      scanningLabel: "Finding Agent opportunities…",
    };
  }
  if (targetLabel === "dataset") {
    return {
      actionLabel: "Find Dataset opportunities",
      description: "Select completed chats that may contain repeated work worth capturing in a reusable Dataset. OpenPond will compare only the chats you choose.",
      scanningLabel: "Finding Dataset opportunities…",
    };
  }
  if (targetLabel === "model") {
    return {
      actionLabel: "Find training opportunities",
      description: "Select completed chats that may contain repeated work worth training into a Model. OpenPond will compare only the chats you choose.",
      scanningLabel: "Finding training opportunities…",
    };
  }
  return {
    actionLabel: "Find repeated work",
    description: `Select completed chats that may contain repeated work worth turning into a ${targetLabel}. OpenPond will compare only the chats you choose.`,
    scanningLabel: "Finding repeated work…",
  };
}

function minerStageLabel(run: TaskMinerRun): string {
  if (run.status === "queued") return "Preparing scan";
  if (run.status === "cancelling") return "Cancelling scan";
  if (run.progress.stage === "ingesting") return "Preparing local evidence";
  if (run.progress.stage === "clustering") return "Clustering repeated work";
  if (run.progress.stage === "persisting") return "Saving recommendations";
  return "Scanning local evidence";
}
