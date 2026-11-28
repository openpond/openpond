import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { LabsView } from "../components/labs/LabsView";
import { LabServingPage } from "../components/labs/LabServingPage";
import "../styles.css";
import "../styles/training/training.css";
import "../styles/labs/labs.css";
import "../styles/labs/labs-inventory.css";



function ModelsBrowserProof() {
  return (
    <main style={{ height: "100vh" }}>
      <LabsView>
        <LabServingPage connection={null} teamId={null} actorId={null} accountKey="browser-proof" />
      </LabsView>
      <output data-testid="models-last-action">none</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ModelsBrowserProof />
  </StrictMode>,
);
