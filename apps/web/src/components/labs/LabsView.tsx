import { useRef, type KeyboardEvent, type ReactNode } from "react";
import type { LabsTab } from "../../lib/app-models";
import { Plus } from "../icons";
import "../../styles/labs/labs.css";

export const LABS_TABS: ReadonlyArray<{ id: LabsTab; label: string }> = [
  { id: "profile", label: "Profile" },
  { id: "signals", label: "Signals" },
  { id: "evals", label: "Evals" },
  { id: "models", label: "Models" },
  { id: "agents", label: "Agents" },
  { id: "extensions", label: "Extensions" },
];

export function LabsView({
  activeTab,
  children,
  onNewModel,
  onTabChange,
  profileHasUncommittedChanges = false,
}: {
  activeTab: LabsTab;
  children: ReactNode;
  onNewModel: () => void;
  onTabChange: (tab: LabsTab) => void;
  profileHasUncommittedChanges?: boolean;
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const lastIndex = LABS_TABS.length - 1;
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? lastIndex
        : event.key === "ArrowLeft"
          ? (index - 1 + LABS_TABS.length) % LABS_TABS.length
          : (index + 1) % LABS_TABS.length;
    const nextTab = LABS_TABS[nextIndex];
    if (!nextTab) return;
    onTabChange(nextTab.id);
    tabRefs.current[nextIndex]?.focus();
  }

  return (
    <section className="labs-route" aria-label="Lab">
      <header className="labs-header">
        <nav className="labs-tabs" role="tablist" aria-label="Lab sections">
          {LABS_TABS.map((tab, index) => (
            <button
              aria-controls="labs-active-panel"
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? "active" : undefined}
              id={`labs-tab-${tab.id}`}
              key={tab.id}
              ref={(node) => { tabRefs.current[index] = node; }}
              role="tab"
              tabIndex={activeTab === tab.id ? 0 : -1}
              title={tab.id === "profile" && profileHasUncommittedChanges
                ? "Profile has local changes that are not committed"
                : undefined}
              type="button"
              onClick={() => onTabChange(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              <span className="labs-tab-label">
                {tab.label}
                {tab.id === "profile" && profileHasUncommittedChanges ? (
                  <span
                    aria-hidden="true"
                    className="labs-profile-change-dot"
                  />
                ) : null}
              </span>
            </button>
          ))}
        </nav>
        <button className="labs-new-model-button" type="button" onClick={onNewModel}>
          <Plus size={14} />
          <span>New model</span>
        </button>
      </header>
      <div
        aria-labelledby={`labs-tab-${activeTab}`}
        className="labs-panel"
        id="labs-active-panel"
        role="tabpanel"
      >
        {children}
      </div>
    </section>
  );
}
