import type { ReactNode } from "react";

import "../../styles/training/training.css";
import "../../styles/labs/labs.css";
import "../../styles/labs/labs-inventory.css";
import "../../styles/labs/labs-detail.css";
import "../../styles/labs/labs-model-detail.css";

export type LabPrimaryTab =
  | "models"
  | "tasksets"
  | "serving"
  | "usage";

export function LabsView({
  activeTab,
  children,
  showHeader = true,
  onCreateDataset,
  onCreateModel,
}: {
  activeTab: LabPrimaryTab;
  children: ReactNode;
  showHeader?: boolean;
  onCreateDataset: () => void;
  onCreateModel: () => void;
}) {
  return (
    <section className="labs-route" aria-label="Models">
      {showHeader ? <header className="labs-header">
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
              <span>New Taskset</span>
            </button>
          ) : null}
        </div>
      </header> : null}
      <div className="labs-panel">{children}</div>
    </section>
  );
}
