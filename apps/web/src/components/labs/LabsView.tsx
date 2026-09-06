import type { ModelProject } from "@openpond/contracts";
import type { ReactNode } from "react";

import "../../styles/training/training.css";
import "../../styles/labs/labs.css";
import "../../styles/labs/taskset-drafts.css";
import "../../styles/labs/labs-inventory.css";
import "../../styles/labs/labs-detail.css";
import "../../styles/labs/labs-model-detail.css";
import "../../styles/labs/lab-model-scoring.css";
import "../../styles/labs/model-project-page.css";
import "../../styles/labs/labs-evals.css";
import "../../styles/labs/labs-model-comparison.css";

export type LabPrimaryTab =
  | "overview"
  | "tasksets"
  | "rewards"
  | "training"
  | "evals"
  | "versions"
  | "serving";

export function LabsView({
  activeTab,
  children,
  showHeader = true,
  onCreateDataset: _onCreateDataset,
  onCreateModel,
}: {
  activeTab: LabPrimaryTab;
  children: ReactNode;
  showHeader?: boolean;
  onCreateDataset: () => void;
  onCreateModel: () => void;
  /** Compatibility props while callers migrate the picker into the sidebar. */
  modelProjects?: ModelProject[];
  selectedModelProjectId?: string | null;
  activeHostedTeamId?: string | null;
  onSelectModelProject?: (modelProjectId: string) => void;
}) {
  return (
    <section className="labs-route" aria-label="Models">
      {showHeader ? <header className="labs-header">
        <div className="labs-header-actions">
          {activeTab === "overview" ? (
            <button
              className="labs-create-button"
              type="button"
              onClick={onCreateModel}
            >
              <span>Create model</span>
            </button>
          ) : null}
        </div>
      </header> : null}
      <div className="labs-panel">{children}</div>
    </section>
  );
}
