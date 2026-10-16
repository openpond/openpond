import type { ComponentProps, PointerEvent as ReactPointerEvent } from "react";
import {
  Clipboard,
  MessageSquare,
  ChartColumnStacked,
  FolderOpen,
  Maximize2,
  Minimize2,
  PanelRight,
  SquareTerminal,
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
  onOpenFiles,
  onOpenAgents,
  onOpenReview,
  onOpenSideChat,
  onOpenTrainingDraft,
  trainingDraftAvailable,
  onResizeStart,
  onToggleExpanded,
  onToggleTerminal,
}: {
  expanded: boolean;
  terminalOpen: boolean;
  sideChatAvailable: boolean;
  onOpenFiles: () => void;
  onOpenAgents?: () => void;
  onOpenReview: () => void;
  onOpenSideChat: () => void;
  onOpenTrainingDraft: () => void;
  trainingDraftAvailable: boolean;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggleExpanded: () => void;
  onToggleTerminal: () => void;
}) {
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
        </div>
      </div>
      <div className="right-sidebar-home-body">
        <RightSidebarHomeActions terminalOpen={terminalOpen} sideChatAvailable={sideChatAvailable}
          onOpenFiles={onOpenFiles} onOpenAgents={onOpenAgents} onOpenReview={onOpenReview}
          onOpenSideChat={onOpenSideChat} onOpenTrainingDraft={onOpenTrainingDraft}
          trainingDraftAvailable={trainingDraftAvailable} onToggleTerminal={onToggleTerminal} />
      </div>
    </aside>
  );
}

export function RightSidebarHomeActions({
  terminalOpen, sideChatAvailable, onOpenFiles, onOpenFile, onOpenReview, onOpenExperiments, onOpenAgents,
  onOpenSideChat, onOpenTrainingDraft, trainingDraftAvailable, onToggleTerminal,
}: Pick<ComponentProps<typeof RightSidebarHomePanel>,
  | "terminalOpen" | "sideChatAvailable" | "onOpenFiles"
  | "onOpenAgents" | "onOpenReview" | "onOpenSideChat" | "onOpenTrainingDraft"
  | "trainingDraftAvailable" | "onToggleTerminal"
> & { onOpenFile?: () => void; onOpenExperiments?: () => void }) {
  const actions: RightSidebarHomeAction[] = [
    { id: "review", label: "Review", meta: "Diffs", icon: Clipboard, onSelect: onOpenReview },
    { id: "files", label: "Files", meta: "Workspace", icon: FolderOpen, onSelect: onOpenFiles },
    {
      id: "side-chat",
      label: "Side chat",
      meta: "Context",
      icon: MessageSquare,
      onSelect: onOpenSideChat,
      disabled: !sideChatAvailable,
    },
    {
      id: "training-draft",
      label: "Task draft",
      meta: "Training",
      icon: ChartColumnStacked,
      onSelect: onOpenTrainingDraft,
      disabled: !trainingDraftAvailable,
    },
    {
      id: "terminal",
      label: terminalOpen ? "Hide terminal" : "Terminal",
      meta: "Shell",
      icon: SquareTerminal,
      onSelect: onToggleTerminal,
    },
  ];

  if (onOpenAgents) actions.push({id:"agents",label:"Agents",icon:MessageSquare,onSelect:onOpenAgents});
  if (onOpenExperiments) actions.unshift({id:"experiments",label:"Training",meta:"Experiments and models",icon:ChartColumnStacked,onSelect:onOpenExperiments});
  if (onOpenFile) actions.splice(onOpenExperiments?3:2, 0, { id: "open-file", label: "Open file", icon: FolderOpen, onSelect: onOpenFile });
  return (
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
  );
}
