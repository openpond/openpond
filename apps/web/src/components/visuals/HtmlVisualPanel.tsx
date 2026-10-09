import type { PointerEvent } from "react";
import type { HtmlVisualReference } from "@openpond/contracts/html-visuals";
import type { ClientConnection } from "../../api";
import { HtmlVisual } from "./HtmlVisual";

export function HtmlVisualPanel({ visual, connection, expanded, onResizeStart, onClose, onToggleExpanded }: {
  visual: HtmlVisualReference; connection: ClientConnection | null; expanded: boolean;
  onResizeStart(event: PointerEvent<HTMLDivElement>): void; onClose(): void; onToggleExpanded(): void;
}) {
  return <aside className={`workspace-diff-panel html-visual-panel ${expanded ? "expanded" : ""}`} aria-label={visual.output.title}>
    {!expanded ? <div className="workspace-diff-resize-handle" role="separator" aria-orientation="vertical" aria-label="Resize visual panel" onPointerDown={onResizeStart} /> : null}
    <div className="html-visual-toolbar"><strong>Visual</strong><button type="button" onClick={onToggleExpanded}>{expanded ? "Restore panel" : "Fill view"}</button><button type="button" onClick={onClose}>Close</button></div>
    <div className="html-visual-panel-body"><HtmlVisual key={visual.publicationId} visual={visual} connection={connection} expanded /></div>
  </aside>;
}
