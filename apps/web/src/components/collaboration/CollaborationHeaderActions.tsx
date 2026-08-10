import { Globe2, MessageSquare } from "../icons";

export function CollaborationHeaderActions({
  activeView,
  onDiscoverCommunities,
  onOpenTeamChat,
}: {
  activeView: "team" | "community" | null;
  onDiscoverCommunities: () => void;
  onOpenTeamChat: () => void;
}) {
  return (
    <div className="titlebar-collaboration-actions">
      <button
        type="button"
        className={`titlebar-icon${activeView === "team" ? " active" : ""}`}
        aria-label="Team chat"
        title="Team chat"
        onClick={onOpenTeamChat}
      >
        <MessageSquare size={16} />
      </button>
      <button
        type="button"
        className={`titlebar-icon${activeView === "community" ? " active" : ""}`}
        aria-label="Discover communities"
        title="Discover communities"
        onClick={onDiscoverCommunities}
      >
        <Globe2 size={16} />
      </button>
    </div>
  );
}
