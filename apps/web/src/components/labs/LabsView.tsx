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

export function LabsView({ children }: { children: ReactNode }) {
  return (
    <section className="labs-route" aria-label="Models">
      <div className="labs-panel">{children}</div>
    </section>
  );
}
