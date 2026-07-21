import type { TrainingChatSearchEntry } from "@openpond/contracts";
import { Loader2, Search } from "../icons";

export type TrainingSourceEstimate = {
  messageCount: number;
  estimatedTokens: number;
};

export function TrainingChatPicker({
  disabled = false,
  estimatesBySessionId,
  matchingSessionCount,
  onLoadMore,
  onSearchChange,
  onToggleSession,
  onToggleVisible,
  reviewOnly = false,
  search,
  searchError,
  searchHasMore,
  searchIndexedChats,
  searchIndexing,
  searchLoading,
  searchTotalChats,
  selectedEntries,
  selectedSessionIds,
  visibleSessions,
}: {
  disabled?: boolean;
  estimatesBySessionId: Record<string, TrainingSourceEstimate>;
  matchingSessionCount: number;
  onLoadMore: () => void;
  onSearchChange: (value: string) => void;
  onToggleSession: (sessionId: string, selected: boolean) => void;
  onToggleVisible: () => void;
  reviewOnly?: boolean;
  search: string;
  searchError: string | null;
  searchHasMore: boolean;
  searchIndexedChats: number;
  searchIndexing: boolean;
  searchLoading: boolean;
  searchTotalChats: number;
  selectedEntries: TrainingChatSearchEntry[];
  selectedSessionIds: Set<string>;
  visibleSessions: TrainingChatSearchEntry[];
}) {
  const everyVisibleSelected = visibleSessions.length > 0
    && visibleSessions.every((entry) => selectedSessionIds.has(entry.sessionId));
  const unselectedResults = visibleSessions.filter((entry) => !selectedSessionIds.has(entry.sessionId));

  return (
    <fieldset className="training-chat-picker" disabled={disabled}>
      {reviewOnly ? null : <div className="training-source-toolbar">
        <label className="training-search">
          <Search size={14} />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search chats"
          />
        </label>
        <button
          className="training-text-button"
          type="button"
          disabled={!visibleSessions.length}
          onClick={onToggleVisible}
        >
          {everyVisibleSelected ? "Clear visible" : "Select visible"}
        </button>
      </div>}
      <div className="training-source-result-count">
        <span>{reviewOnly ? `${selectedEntries.length} selected chat${selectedEntries.length === 1 ? "" : "s"}` : `Showing ${visibleSessions.length} of ${matchingSessionCount} matching chats`}</span>
        {!reviewOnly && searchIndexing ? <span>Indexing messages {searchIndexedChats} of {searchTotalChats}</span> : null}
      </div>
      <div
        className="training-source-options"
        onScroll={(event) => {
          const target = event.currentTarget;
          if (searchHasMore && !searchLoading && target.scrollHeight - target.scrollTop - target.clientHeight < 72) {
            onLoadMore();
          }
        }}
      >
        {selectedEntries.length ? (
          <div className="training-selected-chat-group">
            {selectedEntries.map((entry) => (
              <ChatOption
                key={entry.sessionId}
                checked
                entry={entry}
                estimatesBySessionId={estimatesBySessionId}
                onToggleSession={onToggleSession}
                showSnippet={reviewOnly || Boolean(search.trim())}
              />
            ))}
          </div>
        ) : null}
        {reviewOnly ? null : unselectedResults.map((entry) => (
          <ChatOption
            key={entry.sessionId}
            checked={false}
            entry={entry}
            estimatesBySessionId={estimatesBySessionId}
            onToggleSession={onToggleSession}
            showSnippet={Boolean(search.trim())}
          />
        ))}
        {!reviewOnly && searchLoading ? (
          <div className="training-chat-search-state">
            <Loader2 className="spin" size={15} />
            <span>{visibleSessions.length ? "Loading more chats…" : "Searching chats…"}</span>
          </div>
        ) : null}
        {!reviewOnly && searchError ? <p className="training-empty">Chat search is unavailable. Try again.</p> : null}
        {!reviewOnly && !searchLoading && !searchError && !visibleSessions.length ? (
          <p className="training-empty">
            {searchIndexing ? "No matches yet. Message indexing is still running." : "No completed chats match this search."}
          </p>
        ) : null}
      </div>
    </fieldset>
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
      <input
        className="training-chat-checkbox"
        type="checkbox"
        checked={checked}
        onChange={(event) => onToggleSession(entry.sessionId, event.target.checked)}
      />
      <span>
        <strong>{entry.title}</strong>
        {showSnippet && entry.snippet ? <span className="training-chat-search-snippet">{entry.snippet}</span> : null}
        <small>
          {new Date(entry.updatedAt).toLocaleString()}
          <ChatEstimate estimate={estimatesBySessionId[entry.sessionId]} />
        </small>
      </span>
    </label>
  );
}

function ChatEstimate({ estimate }: { estimate?: TrainingSourceEstimate }) {
  if (!estimate) {
    return <span className="training-chat-estimate"><span>Estimating…</span></span>;
  }
  return (
    <span className="training-chat-estimate">
      <span>{estimate.messageCount} messages</span>
      <span>About {formatTrainingTokens(estimate.estimatedTokens)} tokens</span>
    </span>
  );
}

export function formatTrainingTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}K`;
  return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
}
