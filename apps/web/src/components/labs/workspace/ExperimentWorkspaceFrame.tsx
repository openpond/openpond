import { useState, type CSSProperties, type ReactNode } from "react";
import { WorkspacePanelHost, WorkspacePanelToolbar, useWorkspacePanelControls } from "./WorkspacePanel";
import "../../../styles/labs/evaluation-workspace.css";

/** Shared page geometry for Dataset, experiment and saved Model entry. */
export function ExperimentWorkspaceFrame({ children }: { children: ReactNode }) {
  const panel = useWorkspacePanelControls();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return <WorkspacePanelHost.Provider value={host}>
    <section className="evaluation-workspace" data-panel-open={panel?.open} data-panel-side="right"
      style={{ "--evaluation-panel-width": `${panel?.width ?? 440}px` } as CSSProperties} aria-label="Training workspace">
      <div className="evaluation-workspace-main">{children}</div>
      <aside className="evaluation-workspace-panel" aria-label="Details sidebar">
        <div className="evaluation-panel-resize" role="separator" tabIndex={0} aria-label="Resize sidebar" aria-orientation="vertical"
          aria-valuemin={320} aria-valuemax={800} aria-valuenow={panel?.width}
          onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); panel?.resize((panel?.width ?? 440) + (event.key === "ArrowLeft" ? 24 : -24)); } }}
          onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
          onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { const rect = event.currentTarget.parentElement?.getBoundingClientRect(); if (rect) panel?.resize(rect.right - event.clientX); } }}
          onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} />
        <WorkspacePanelToolbar />
        <div ref={setHost} />
      </aside>
    </section>
  </WorkspacePanelHost.Provider>;
}
