import type { PointerEvent as ReactPointerEvent } from "react";
import {
  Clipboard,
  FolderOpen,
  Globe2,
  Maximize2,
  MessageSquare,
  Minimize2,
  PanelRight,
  SquareTerminal,
  X,
  type LucideIcon,
} from "../icons";

type RightSidebarHomeAction = {
  id: string;
  label: string;
  meta?: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
};

export function RightSidebarHomePanel({
  expanded,
  terminalOpen,
  sideChatAvailable,
  onClose,
  onOpenBrowser,
  onOpenFiles,
  onOpenReview,
  onOpenSideChat,
  onResizeStart,
  onToggleExpanded,
  onToggleTerminal,
}: {
  expanded: boolean;
  terminalOpen: boolean;
  sideChatAvailable: boolean;
  onClose: () => void;
  onOpenBrowser: () => void;
  onOpenFiles: () => void;
  onOpenReview: () => void;
  onOpenSideChat: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggleExpanded: () => void;
  onToggleTerminal: () => void;
}) {
  const actions: RightSidebarHomeAction[] = [
    { id: "review", label: "Review", meta: "Diffs", icon: Clipboard, onSelect: onOpenReview },
    { id: "files", label: "Files", meta: "Workspace", icon: FolderOpen, onSelect: onOpenFiles },
    { id: "browser", label: "Browser", meta: "Preview", icon: Globe2, onSelect: onOpenBrowser },
    {
      id: "side-chat",
      label: "Side chat",
      meta: "Context",
      icon: MessageSquare,
      onSelect: onOpenSideChat,
      disabled: !sideChatAvailable,
    },
    {
      id: "terminal",
      label: terminalOpen ? "Hide terminal" : "Terminal",
      meta: "Shell",
      icon: SquareTerminal,
      onSelect: onToggleTerminal,
    },
  ];

  return (
    <aside className={`workspace-diff-panel right-sidebar-home-panel ${expanded ? "expanded" : ""}`} aria-label="Right sidebar">
      {!expanded ? (
        <div
          className="workspace-diff-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize right sidebar"
          onPointerDown={onResizeStart}
        />
      ) : null}
      <div className="workspace-diff-topbar right-sidebar-home-topbar">
        <div className="workspace-diff-tabs" role="tablist" aria-label="Right sidebar views">
          <button type="button" className="workspace-diff-tab active" role="tab" aria-selected>
            <PanelRight size={14} />
            <span>Workspace</span>
          </button>
        </div>
        <div className="workspace-diff-toolbar-actions">
          <button
            type="button"
            className="diff-icon-button"
            title={expanded ? "Dock sidebar" : "Expand sidebar"}
            aria-label={expanded ? "Dock sidebar" : "Expand sidebar"}
            onClick={onToggleExpanded}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button type="button" className="diff-icon-button" title="Close sidebar" aria-label="Close sidebar" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="right-sidebar-home-body">
        <div className="right-sidebar-home-actions" role="menu" aria-label="Workspace actions">
          {actions.map((action) => (
            <button
              type="button"
              className="right-sidebar-home-row"
              key={action.id}
              role="menuitem"
              disabled={action.disabled}
              onClick={action.onSelect}
            >
              <action.icon size={15} />
              <span>{action.label}</span>
              {action.meta ? <span className="right-sidebar-home-chip">{action.meta}</span> : null}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
