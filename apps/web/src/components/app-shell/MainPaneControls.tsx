import type { ChatProvider, FireworksModelServingSession } from "@openpond/contracts";
import type { AppView } from "../../lib/app-models";
import type { TrainingModelChatHandoff } from "../../lib/training-model-chat-handoff";
import { TrainingModelChatHandoffBar } from "../chat/TrainingModelChatHandoffBar";
import { ArrowDown, ArrowLeft, ArrowRight, DownloadCloud } from "../icons";

export function ActiveTrainingChatHandoffBar({
  activeModel,
  activeProvider,
  busy,
  handoff,
  onDismiss,
  onSelectTask,
  onStopServing,
  servingSessions,
}: {
  activeModel: string;
  activeProvider: ChatProvider;
  busy: boolean;
  handoff: TrainingModelChatHandoff | null;
  onDismiss: () => void;
  onSelectTask: (index: number) => void;
  onStopServing: (sessionId: string) => void;
  servingSessions: FireworksModelServingSession[];
}) {
  if (
    !handoff
    || handoff.model.providerId !== activeProvider
    || handoff.model.modelId !== activeModel
  ) {
    return null;
  }
  const servingSession = servingSessions
    .filter((session) => session.modelArtifactLineageId === handoff.model.modelId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  return (
    <TrainingModelChatHandoffBar
      busy={busy}
      handoff={handoff}
      onDismiss={onDismiss}
      onSelectTask={onSelectTask}
      servingSession={servingSession}
      onStopServing={onStopServing}
    />
  );
}

export function MessageNavigationControls({
  canGoNext,
  canGoPrevious,
  onJumpToLatest,
  onNext,
  onPrevious,
}: {
  canGoNext: boolean;
  canGoPrevious: boolean;
  onJumpToLatest: () => void;
  onNext: () => void;
  onPrevious: () => void;
}) {
  return (
    <div className="chat-scroll-controls" aria-label="Message navigation">
      <button
        type="button"
        className="chat-scroll-control-button"
        data-tooltip="Go to previous message"
        aria-label="Go to previous message"
        aria-disabled={!canGoPrevious}
        onClick={onPrevious}
      >
        <ArrowLeft size={17} />
      </button>
      <button
        type="button"
        className="chat-scroll-control-button primary"
        data-tooltip="Jump to latest"
        aria-label="Jump to latest"
        onClick={onJumpToLatest}
      >
        <ArrowDown size={18} />
      </button>
      <button
        type="button"
        className="chat-scroll-control-button"
        data-tooltip="Go to next message"
        aria-label="Go to next message"
        aria-disabled={!canGoNext}
        onClick={onNext}
      >
        <ArrowRight size={17} />
      </button>
    </div>
  );
}

export function WorkspaceSyncButton({
  busy,
  onSync,
}: {
  busy: boolean;
  onSync: () => void;
}) {
  return (
    <button
      type="button"
      className="sync-local-button"
      disabled={busy}
      onClick={onSync}
    >
      <DownloadCloud size={15} />
      <span>{busy ? "Syncing locally" : "Sync locally to work on this"}</span>
    </button>
  );
}

export function shouldShowRightSidebarHomePanel(input: {
  supportedView: boolean;
  open: boolean;
  hasContentPanel: boolean;
}): boolean {
  return input.supportedView && input.open && !input.hasContentPanel;
}

export function mainPaneViewClass(view: AppView, showChatThread: boolean): string {
  if (view === "team") return "team-active";
  if (view === "community") return "community-active";
  if (view === "apps" || view === "get-started" || view === "labs") return "page-active";
  if (view === "cloud") return "cloud-active";
  return showChatThread ? "chat-active" : "chat-start";
}
