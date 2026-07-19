import type { useTraining } from "../../hooks/useTraining";
import { ChartColumnStacked, Maximize2, Minimize2 } from "../icons";
import type { PointerEvent as ReactPointerEvent } from "react";
import "../../styles/training/training.css";

export function TrainingDraftPanel({ training, sessionId, expanded, onOpenTraining, onResizeStart, onToggleExpanded }: { training: ReturnType<typeof useTraining>; sessionId: string | null; expanded: boolean; onOpenTraining: () => void; onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void; onToggleExpanded: () => void }) {
  const sources = training.payload?.sources.filter((source) => source.sessionId === sessionId) ?? [];
  const sourceIds = new Set(sources.map((source) => source.id));
  const creation = training.payload?.creations.find((item) => item.request.sourceIds.some((id) => sourceIds.has(id))) ?? null;
  return <aside className={`workspace-diff-panel training-draft-panel ${expanded ? "expanded" : ""}`} aria-label="Training task draft">
    {!expanded ? <div className="workspace-diff-resize-handle" role="separator" aria-orientation="vertical" aria-label="Resize task draft" onPointerDown={onResizeStart} /> : null}
    <div className="workspace-diff-topbar"><div className="workspace-diff-tabs"><button type="button" className="workspace-diff-tab active"><ChartColumnStacked size={14}/><span>Task draft</span></button></div><div className="workspace-diff-toolbar-actions"><button className="diff-icon-button" type="button" onClick={onToggleExpanded} aria-label={expanded ? "Dock task draft" : "Expand task draft"}>{expanded ? <Minimize2 size={14}/> : <Maximize2 size={14}/>}</button></div></div>
    <div className="training-draft-body">
      <span className="training-eyebrow">Selected chat</span>
      <h2>{sources[0]?.title ?? "Not added to training"}</h2>
      <dl className="training-definition"><div><dt>Sources</dt><dd>{sources.length}</dd></div><div><dt>Status</dt><dd>{creation?.state.replaceAll("_", " ") ?? "No draft"}</dd></div><div><dt>Method</dt><dd>{creation?.proposal?.proposedMethod ?? "Pending"}</dd></div></dl>
      {creation?.proposal ? <><h3>{creation.proposal.name}</h3><p>{creation.proposal.objective}</p></> : <p>Add this chat with the sidebar action or run <code>/train</code>.</p>}
      {creation?.blockedReason ? <p className="training-draft-warning">{creation.blockedReason}</p> : null}
      <button className="training-button secondary" type="button" onClick={onOpenTraining}>Open Training</button>
    </div>
  </aside>;
}
