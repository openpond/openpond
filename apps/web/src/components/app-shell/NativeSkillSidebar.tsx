import type { PointerEvent as ReactPointerEvent } from "react";
import { FileText, Maximize2, Minimize2, X } from "../icons";
import type { SkillSourceDocument } from "./skill-source-document";
import "../../styles/app-shell/native-skill-sidebar.css";

export function NativeSkillSidebar({
  expanded,
  skill,
  onClose,
  onResizeStart,
  onToggleExpanded,
}: {
  expanded: boolean;
  skill: SkillSourceDocument;
  onClose: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggleExpanded: () => void;
}) {
  const fileName = skill.path.split("/").at(-1) ?? skill.path;

  return (
    <aside
      className={`workspace-diff-panel native-skill-sidebar ${expanded ? "expanded" : ""}`}
      aria-label={`Skill source: ${skill.name}`}
    >
      {!expanded ? (
        <div
          className="workspace-diff-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize native skill source"
          onPointerDown={onResizeStart}
        />
      ) : null}
      <div className="workspace-diff-topbar native-skill-sidebar-topbar">
        <div className="workspace-diff-tabs" role="tablist" aria-label="Native skill files">
          <button className="workspace-diff-tab active" type="button" role="tab" aria-selected>
            <FileText size={14} />
            <span>{fileName}</span>
          </button>
        </div>
        <div className="workspace-diff-toolbar-actions">
          <button
            className="diff-icon-button"
            type="button"
            title={expanded ? "Dock sidebar" : "Expand sidebar"}
            aria-label={expanded ? "Dock sidebar" : "Expand sidebar"}
            onClick={onToggleExpanded}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            className="diff-icon-button"
            type="button"
            title="Close skill source"
            aria-label="Close skill source"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="native-skill-sidebar-body">
        <header className="native-skill-source-header">
          <h2>{skill.name}</h2>
          <p>{skill.description}</p>
          <code>{skill.path}</code>
        </header>
        <pre className="native-skill-markdown-source" aria-label={`${skill.name} Markdown source`}>
          <code>{skill.body}</code>
        </pre>
      </div>
    </aside>
  );
}
