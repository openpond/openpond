import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "../icons";
import "./sidebar-model-resource.css";

export function SidebarResourceRow({ name, icon, onOpen, actions, status, children }: {
  name: string;
  icon?: ReactNode;
  onOpen?(): void;
  actions?: ReactNode;
  status?: ReactNode;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggle = () => setExpanded(value => !value);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return <div className="sidebar-model-resource">
    <div className="sidebar-model-row">
      {onOpen && children ? <button type="button" className="sidebar-icon" aria-label={`${expanded ? "Collapse" : "Expand"} ${name} chats`}
        aria-expanded={expanded} onClick={toggle}>
        <Chevron size={13} />
      </button> : null}
      <button type="button" className="sidebar-model-title" title={name} aria-expanded={onOpen ? undefined : expanded} onClick={onOpen ?? toggle}>
        {onOpen ? null : <Chevron size={13} aria-hidden="true" />}{icon}<span>{name}</span>
      </button>
      {actions ? <div className="sidebar-model-actions">{actions}</div> : null}
    </div>
    {status}
    {expanded ? <div className="sidebar-model-threads">{children || <span className="training-muted">No chats yet</span>}</div> : null}
  </div>;
}
