import type { ReactNode } from "react";

import { Boxes } from "../icons";
import "../../styles/training/training.css";
import "../../styles/labs/labs.css";
import "../../styles/labs/labs-inventory.css";
import "../../styles/labs/labs-detail.css";
import "../../styles/labs/labs-model-detail.css";

export type LabPrimaryTab =
  | "models"
  | "tasksets";

export function LabsView({
  activeTab,
  children,
  showHeader = true,
  onTabChange,
  onCreateDataset,
  onCreateModel,
}: {
  activeTab: LabPrimaryTab;
  children: ReactNode;
  showHeader?: boolean;
  onTabChange: (tab: LabPrimaryTab) => void;
  onCreateDataset: () => void;
  onCreateModel: () => void;
}) {
  return (
    <section className="labs-route" aria-label="Models">
      {showHeader ? <header className="labs-header">
        <div className="labs-header-navigation">
          <nav className="labs-primary-tabs" role="tablist" aria-label="Model sections">
            <button
              aria-selected={activeTab === "models"}
              className={activeTab === "models" ? "active" : undefined}
              role="tab"
              type="button"
              onClick={() => onTabChange("models")}
            >
              Models
            </button>
            <button
              aria-selected={activeTab === "tasksets"}
              className={activeTab === "tasksets" ? "active" : undefined}
              role="tab"
              type="button"
              onClick={() => onTabChange("tasksets")}
            >
              Tasksets
            </button>
          </nav>
        </div>
        <div className="labs-header-actions">
          {activeTab === "models" ? (
            <button
              className="labs-create-button"
              type="button"
              onClick={onCreateModel}
            >
              <span>New model</span>
            </button>
          ) : activeTab === "tasksets" ? (
            <button
              className="labs-create-button"
              type="button"
              onClick={onCreateDataset}
            >
              <Boxes size={13} />
              <span>New Taskset</span>
            </button>
          ) : null}
        </div>
      </header> : null}
      <div className="labs-panel">{children}</div>
    </section>
  );
}
