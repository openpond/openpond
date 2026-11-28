import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "../icons";
import "./sidebar-model-resource.css";

export function SidebarResourceRow({ name, onOpen, actions, status, children }: {
  name: string;
  onOpen(): void;
  actions?: ReactNode;
  status?: ReactNode;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return <div className="sidebar-model-resource">
    <div className="sidebar-model-row">
      {children ? <button type="button" className="sidebar-icon" aria-label={`${expanded ? "Collapse" : "Expand"} ${name} chats`}
        aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button> : null}
      <button type="button" className="sidebar-model-title" onClick={onOpen}>{name}</button>
      {actions}
    </div>
    {status}
    {expanded && children ? <div className="sidebar-model-threads">{children}</div> : null}
  </div>;
}
