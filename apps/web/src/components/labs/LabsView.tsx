import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  BookOpenText,
  Bot,
  Boxes,
  ChartColumnStacked,
  Plug,
  Plus,
} from "../icons";
import "../../styles/labs/labs.css";
import "../../styles/labs/labs-detail.css";

export type LabPrimaryTab = "workproducts" | "datasets" | "suggestions";

export function LabsView({
  activeTab,
  children,
  suggestionCount,
  showHeader = true,
  onTabChange,
  onCreateAgent,
  onCreateDataset,
  onCreateModel,
}: {
  activeTab: LabPrimaryTab;
  children: ReactNode;
  suggestionCount: number;
  showHeader?: boolean;
  onTabChange: (tab: LabPrimaryTab) => void;
  onCreateAgent: () => void;
  onCreateDataset: () => void;
  onCreateModel: () => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const createRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!createOpen) return undefined;
    function close(event: PointerEvent) {
      if (!createRef.current?.contains(event.target as Node)) setCreateOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setCreateOpen(false);
    }
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [createOpen]);

  return (
    <section className="labs-route" aria-label="Lab">
      {showHeader ? <header className="labs-header">
        <div className="labs-header-navigation">
          <nav className="labs-primary-tabs" role="tablist" aria-label="Lab sections">
            <button
              aria-selected={activeTab === "workproducts"}
              className={activeTab === "workproducts" ? "active" : undefined}
              role="tab"
              type="button"
              onClick={() => onTabChange("workproducts")}
            >
              Home
            </button>
            <button
              aria-selected={activeTab === "datasets"}
              className={activeTab === "datasets" ? "active" : undefined}
              role="tab"
              type="button"
              onClick={() => onTabChange("datasets")}
            >
              Datasets
            </button>
            <button
              aria-selected={activeTab === "suggestions"}
              className={activeTab === "suggestions" ? "active" : undefined}
              role="tab"
              type="button"
              onClick={() => onTabChange("suggestions")}
            >
              Suggestions
              {suggestionCount > 0 ? <span>{suggestionCount}</span> : null}
            </button>
          </nav>
        </div>
        <div className="labs-header-actions">
          <div className="labs-create-anchor" ref={createRef}>
            <button
              className="labs-create-button"
              type="button"
              aria-expanded={createOpen}
              aria-haspopup="menu"
              aria-label="Create workproduct"
              title="Create workproduct"
              onClick={() => setCreateOpen((open) => !open)}
            >
              <Plus size={15} />
            </button>
            {createOpen ? (
              <div className="labs-create-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCreateOpen(false);
                    onCreateAgent();
                  }}
                >
                  <Bot size={15} />
                  <span><strong>New agent</strong><small>Describe the agent in the shared Create flow.</small></span>
                </button>
                <button disabled type="button" role="menuitem">
                  <BookOpenText size={15} />
                  <span>
                    <strong>New skill</strong>
                    <small>Coming soon</small>
                  </span>
                </button>
                <button disabled type="button" role="menuitem">
                  <Plug size={15} />
                  <span>
                    <strong>New extension</strong>
                    <small>Coming soon</small>
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCreateOpen(false);
                    onCreateModel();
                  }}
                >
                  <ChartColumnStacked size={15} />
                  <span><strong>New model</strong><small>Build the data and Evals, then choose training.</small></span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCreateOpen(false);
                    onCreateDataset();
                  }}
                >
                  <Boxes size={15} />
                  <span><strong>New Dataset</strong><small>Create a reusable Taskset without creating a Model.</small></span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header> : null}
      <div className="labs-panel">{children}</div>
    </section>
  );
}
