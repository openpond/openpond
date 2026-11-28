import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "../icons";
import { SidebarInteractiveRow } from "./SidebarRows";
import "./sidebar-model-resource.css";

export function SidebarResourceRow({ name, icon, onOpen, onActivate, onToggle, selected = false, leadingActions, actions, status, children }: {
  name: string;
  icon?: ReactNode;
  onOpen?(): void;
  onActivate?(): void;
  onToggle?(expanded: boolean): void;
  selected?: boolean;
  leadingActions?: ReactNode;
  actions?: ReactNode;
  status?: ReactNode;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggle = () => { setExpanded(!expanded); onToggle?.(!expanded); };
  const Chevron = expanded ? ChevronDown : ChevronRight;
  if (!onOpen) return <div className="sidebar-model-resource">
    <SidebarInteractiveRow className="sidebar-project-row sidebar-model-project-row"
      selected={selected} ariaExpanded={expanded} onSelect={() => { toggle(); onActivate?.(); }}>
      <span className="sidebar-model-icon" aria-hidden="true">{icon}</span>
      <span className="sidebar-project-title-line">
        <span className="row-label" title={name}>{name}</span>
      </span>
      <div className="row-meta"><div className="sidebar-row-actions sidebar-model-hover-actions"
        onClick={event => event.stopPropagation()}>
        {leadingActions}
        <button type="button" className="sidebar-row-action" aria-label={`${expanded ? "Collapse" : "Expand"} ${name} chats`}
          aria-expanded={expanded} onClick={toggle}><Chevron size={13} aria-hidden="true" /></button>
        {actions}
      </div></div>
    </SidebarInteractiveRow>
    {status}
    {expanded ? <div className="sidebar-model-threads">{children ?? <span className="training-muted">No chats yet</span>}</div> : null}
  </div>;
  return <div className="sidebar-model-resource">
    <div className="sidebar-model-row">
      {children ? <button type="button" className="sidebar-icon" aria-label={`${expanded ? "Collapse" : "Expand"} ${name} chats`}
        aria-expanded={expanded} onClick={toggle}>
        <Chevron size={13} />
      </button> : null}
      <button type="button" className="sidebar-model-title" title={name} onClick={onOpen}>
        {icon}<span>{name}</span>
      </button>
      {actions ? <div className="sidebar-model-actions">{actions}</div> : null}
    </div>
    {status}
    {expanded ? <div className="sidebar-model-threads">{children || <span className="training-muted">No chats yet</span>}</div> : null}
  </div>;
}
