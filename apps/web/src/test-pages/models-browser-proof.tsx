import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { TrainingStateResponse } from "@openpond/contracts";

import {
  LabsView,
  type LabPrimaryTab,
} from "../components/labs/LabsView";
import { LabServingPage } from "../components/labs/LabServingPage";
import "../styles.css";
import "../styles/training/training.css";
import "../styles/labs/labs.css";
import "../styles/labs/labs-inventory.css";

const state = {
  modelProjects: [
    {
      id: "model_support",
      name: "Support model",
    },
  ],
  modelVersions: [
    {
      artifactLineageId: "lineage_support_v2",
      version: 2,
    },
  ],
  models: [
    {
      id: "lineage_support_v2",
      modelId: "model_support",
      importedAt: "2026-07-30T10:00:00.000Z",
      managedServing: {
        state: "ready",
        canonicalArtifactState: "promotable",
        canonicalDeploymentState: "ready",
        customerBindingAllowed: true,
        lastSyncedAt: "2026-07-30T11:00:00.000Z",
      },
    },
  ],
} as unknown as TrainingStateResponse;

function ModelsBrowserProof() {
  const activeTab: LabPrimaryTab = "serving";
  const [lastAction, setLastAction] = useState("none");

  return (
    <main style={{ height: "100vh" }}>
      <LabsView
        activeTab={activeTab}
        onCreateDataset={() => setLastAction("create-taskset")}
        onCreateModel={() => setLastAction("create-model")}
      >
        {activeTab === "serving" ? (
          <LabServingPage state={state} />
        ) : (
          <div className="labs-flat-body">
            <div className="labs-table-empty">{activeTab} proof</div>
          </div>
        )}
      </LabsView>
      <output data-testid="models-last-action">{lastAction}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ModelsBrowserProof />
  </StrictMode>,
);
