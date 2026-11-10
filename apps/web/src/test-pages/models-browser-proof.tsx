import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  LabsView,
  type LabPrimaryTab,
} from "../components/labs/LabsView";
import { LabServingPage } from "../components/labs/LabServingPage";
import "../styles.css";
import "../styles/training/training.css";
import "../styles/labs/labs.css";
import "../styles/labs/labs-inventory.css";



function ModelsBrowserProof() {
  const activeTab: LabPrimaryTab = "serving";
  const [lastAction, setLastAction] = useState("none");

  return (
    <main style={{ height: "100vh" }}>
      <LabsView
        activeTab={activeTab}
        modelProjects={[]}
        selectedModelProjectId={null}
        onSelectModelProject={() => undefined}
        onCreateDataset={() => setLastAction("create-taskset")}
        onCreateModel={() => setLastAction("create-model")}
      >
        {activeTab === "serving" ? (
          <LabServingPage connection={null} teamId={null} actorId={null} accountKey="browser-proof" />
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
