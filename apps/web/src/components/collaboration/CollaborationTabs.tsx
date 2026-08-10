import type { AppView } from "../../lib/app-models";
import { Globe2 } from "../icons";
import "../../styles/collaboration/collaboration-tabs.css";

export function CollaborationTabs({
  onSelect,
  view,
}: {
  onSelect: (view: "team" | "community") => void;
  view: Extract<AppView, "team" | "community">;
}) {
  return (
    <nav className="collaboration-tabs" aria-label="Collaboration">
      <button
        aria-current={view === "team" ? "page" : undefined}
        className={view === "team" ? "active" : ""}
        onClick={() => onSelect("team")}
        type="button"
      >
        <span>Team chat</span>
      </button>
      <button
        aria-current={view === "community" ? "page" : undefined}
        className={view === "community" ? "active" : ""}
        onClick={() => onSelect("community")}
        type="button"
      >
        <Globe2 size={15} />
        <span>Communities</span>
      </button>
    </nav>
  );
}
