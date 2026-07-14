import { useMemo } from "react";
import type { ChatProvider, CodexReasoningEffort, ProviderSettings, TrainingChatSearchEntry } from "@openpond/contracts";
import { DropdownSelect } from "../DropdownSelect";
import { CodexModelReasoningMenu } from "../chat/ComposerControls";
import { Loader2, Search } from "../icons";
import {
  modelOptionsForProvider,
  providerModelSupportsReasoning,
  providerOptionsFromSettings,
} from "../../lib/app-models";
import type { NewModelMode } from "./TrainingStartModeStep";

export type TrainingSourceEstimate = { messageCount: number; estimatedTokens: number };

export function TrainingSourceStep({
  authoringModel,
  authoringProvider,
  authoringReasoningEffort,
  busy,
  disclosurePending,
  estimatesBySessionId,
  matchingSessionCount,
  mode,
  objective,
  onAnalyze,
  onApproveDisclosure,
  onAuthoringModelChange,
  onAuthoringProviderChange,
  onAuthoringReasoningEffortChange,
  onDeclineDisclosure,
  onSearchChange,
  onLoadMore,
  onReturnToRecommendation,
  onToggleSession,
  onToggleVisible,
  providerSettings,
  recommendationAvailable,
  search,
  searchError,
  searchHasMore,
  searchIndexedChats,
  searchIndexing,
  searchLoading,
  searchTotalChats,
  selectedEntries,
  selectedEstimate,
  selectedSessionIds,
  visibleSessions,
}: {
  authoringModel: string;
  authoringProvider: ChatProvider;
  authoringReasoningEffort: CodexReasoningEffort;
  busy: boolean;
  disclosurePending: boolean;
  estimatesBySessionId: Record<string, TrainingSourceEstimate>;
  matchingSessionCount: number;
  mode: NewModelMode;
  objective: string;
  onAnalyze: () => void;
  onApproveDisclosure: () => void;
  onAuthoringModelChange: (value: string) => void;
  onAuthoringProviderChange: (value: ChatProvider) => void;
  onAuthoringReasoningEffortChange: (value: CodexReasoningEffort) => void;
  onDeclineDisclosure: () => void;
  onSearchChange: (value: string) => void;
  onLoadMore: () => void;
  onReturnToRecommendation: () => void;
  onToggleSession: (sessionId: string, selected: boolean) => void;
  onToggleVisible: () => void;
  providerSettings: ProviderSettings | null;
  recommendationAvailable: boolean;
  search: string;
  searchError: string | null;
  searchHasMore: boolean;
  searchIndexedChats: number;
  searchIndexing: boolean;
  searchLoading: boolean;
  searchTotalChats: number;
  selectedEntries: TrainingChatSearchEntry[];
  selectedEstimate: TrainingSourceEstimate & { measuredChats: number };
  selectedSessionIds: Set<string>;
  visibleSessions: TrainingChatSearchEntry[];
}) {
  const providerOptions = useMemo(() => providerOptionsFromSettings(providerSettings, { enabledOnly: true }), [providerSettings]);
  const modelOptions = useMemo(() => modelOptionsForProvider(authoringProvider, providerSettings), [authoringProvider, providerSettings]);
  const showReasoning = providerModelSupportsReasoning(authoringProvider, authoringModel, providerSettings);
  const selectedCount = selectedSessionIds.size;
  const everyVisibleSelected = visibleSessions.length > 0 && visibleSessions.every((entry) => selectedSessionIds.has(entry.sessionId));
  const unselectedResults = visibleSessions.filter((entry) => !selectedSessionIds.has(entry.sessionId));
  const canAnalyze = selectedCount > 0 || (mode === "manual" && Boolean(objective.trim()));

  return (
    <>
      <div className="training-dialog-scroll-body">
        <div className="training-run-step-heading">
          <h3>Review supporting chats</h3>
          <p>{mode === "automated" ? "Approve the chats that support this repeated workflow." : "Add successful examples, corrections, reviewer choices, or outcome-bearing runs."}</p>
        </div>

        {objective ? <div className="training-evidence-objective"><span>Capability</span><strong>{objective}</strong></div> : null}

        <fieldset className="training-evidence-fields" disabled={busy || disclosurePending}>
          <div className="training-source-toolbar">
            <label className="training-search"><Search size={14} /><input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search chats" /></label>
            <button className="training-text-button" type="button" disabled={!visibleSessions.length} onClick={onToggleVisible}>{everyVisibleSelected ? "Clear visible" : "Select visible"}</button>
          </div>
          <div className="training-source-result-count">
            <span>Showing {visibleSessions.length} of {matchingSessionCount} matching chats</span>
            {searchIndexing ? <span>Indexing messages {searchIndexedChats} of {searchTotalChats}</span> : null}
          </div>
          <div
            className="training-source-options"
            onScroll={(event) => {
              const target = event.currentTarget;
              if (searchHasMore && !searchLoading && target.scrollHeight - target.scrollTop - target.clientHeight < 72) onLoadMore();
            }}
          >
            {selectedEntries.length ? <div className="training-selected-chat-group">{selectedEntries.map((entry) => (
              <ChatOption key={entry.sessionId} entry={entry} checked estimatesBySessionId={estimatesBySessionId} onToggleSession={onToggleSession} showSnippet={Boolean(search.trim())} />
            ))}</div> : null}
            {unselectedResults.map((entry) => (
              <ChatOption key={entry.sessionId} entry={entry} checked={false} estimatesBySessionId={estimatesBySessionId} onToggleSession={onToggleSession} showSnippet={Boolean(search.trim())} />
            ))}
            {searchLoading ? <div className="training-chat-search-state"><Loader2 className="spin" size={15} /><span>{visibleSessions.length ? "Loading more chats…" : "Searching chats…"}</span></div> : null}
            {searchError ? <p className="training-empty">{searchError}</p> : null}
            {!searchLoading && !searchError && !visibleSessions.length ? <p className="training-empty">{searchIndexing ? "No matches yet. Message indexing is still running." : "No completed chats match this search."}</p> : null}
          </div>

          <div className="training-authoring-row">
            <span>Analyzed with</span>
            <div className="training-authoring-controls" aria-label="Analysis model">
              <DropdownSelect compact placement="bottom" label="Provider" value={authoringProvider} options={providerOptions} disabled={busy} onChange={(value) => onAuthoringProviderChange(value as ChatProvider)} />
              {showReasoning ? (
                <CodexModelReasoningMenu disabled={busy} model={authoringModel} modelOptions={modelOptions} placement="bottom" reasoningEffort={authoringReasoningEffort} onModelChange={onAuthoringModelChange} onReasoningEffortChange={onAuthoringReasoningEffortChange} />
              ) : (
                <DropdownSelect compact placement="bottom" label="Model" value={authoringModel} options={modelOptions} disabled={busy} onChange={onAuthoringModelChange} />
              )}
            </div>
          </div>
        </fieldset>

        {disclosurePending ? (
          <div className="training-disclosure-review" role="status">
            <strong>Approve evidence disclosure</strong>
            <p><b>{authoringProvider} / {authoringModel}</b> will receive raw excerpts from {selectedCount} selected chat{selectedCount === 1 ? "" : "s"}, {selectedEstimate.messageCount} messages, and approximately {formatTokens(selectedEstimate.estimatedTokens)} tokens. Unselected local chats and the local search index are not sent.</p>
          </div>
        ) : null}
      </div>

      <div className="training-dialog-actions">
        <span className="training-selection-count">
          {selectedCount === 0 ? "No supporting chats selected" : selectedEstimate.measuredChats === selectedCount ? <><span>{selectedCount} chat{selectedCount === 1 ? "" : "s"}</span><span>{selectedEstimate.messageCount} messages</span><span>About {formatTokens(selectedEstimate.estimatedTokens)} tokens</span></> : <><span>{selectedCount} chat{selectedCount === 1 ? "" : "s"}</span><span>Estimating…</span></>}
        </span>
        {disclosurePending ? <>
          <button className="training-button secondary" type="button" disabled={busy} onClick={onDeclineDisclosure}>Change evidence</button>
          <button className="training-button" type="button" disabled={busy || selectedEstimate.measuredChats !== selectedCount} onClick={onApproveDisclosure}>{busy ? <Loader2 className="spin" size={14} /> : null}Approve and analyze</button>
        </> : recommendationAvailable ? <>
          <button className="training-button secondary" type="button" disabled={busy} onClick={onAnalyze}>Reanalyze changes</button>
          <button className="training-button" type="button" onClick={onReturnToRecommendation}>Return to recommendation</button>
        </> : (
          <button className="training-button" type="button" disabled={!canAnalyze || busy || (selectedCount > 0 && selectedEstimate.measuredChats !== selectedCount)} onClick={onAnalyze}>{busy ? <Loader2 className="spin" size={14} /> : null}Review disclosure</button>
        )}
      </div>
    </>
  );
}

function ChatOption({
  checked,
  entry,
  estimatesBySessionId,
  onToggleSession,
  showSnippet,
}: {
  checked: boolean;
  entry: TrainingChatSearchEntry;
  estimatesBySessionId: Record<string, TrainingSourceEstimate>;
  onToggleSession: (sessionId: string, selected: boolean) => void;
  showSnippet: boolean;
}) {
  return (
    <label>
      <input className="training-chat-checkbox" type="checkbox" checked={checked} onChange={(event) => onToggleSession(entry.sessionId, event.target.checked)} />
      <span>
        <strong>{entry.title}</strong>
        {showSnippet && entry.snippet ? <span className="training-chat-search-snippet">{entry.snippet}</span> : null}
        <small>{new Date(entry.updatedAt).toLocaleString()}<ChatEstimate estimate={estimatesBySessionId[entry.sessionId]} /></small>
      </span>
    </label>
  );
}

function ChatEstimate({ estimate }: { estimate?: TrainingSourceEstimate }) {
  if (!estimate) return <span className="training-chat-estimate"><span>Estimating…</span></span>;
  return <span className="training-chat-estimate"><span>{estimate.messageCount} messages</span><span>About {formatTokens(estimate.estimatedTokens)} tokens</span></span>;
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}K`;
  return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
}
