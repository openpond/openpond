import { useState, type ReactNode } from "react";
import { DropdownSelect } from "../DropdownSelect";
import { MoreVertical } from "../icons";

export type ResourceAction = { label: string; run: () => void; disabled?: boolean; expanded?: boolean; controls?: string };

/** Shared table chrome: one row, with secondary actions and metadata on demand. */
export function ChatResourceToolbar({ name, version, summary, primary, actions = [], children }: {
  name: string;
  version: number;
  summary: string;
  primary: ResourceAction;
  actions?: ResourceAction[];
  children?: ReactNode;
}) {
  const [details, setDetails] = useState(false);
  const choices = [primary, ...actions];
  return <>
    <header className="chat-resource-toolbar">
      <strong title={name}>{name}</strong>
      <span className="chat-resource-version">V{version}</span>
      <span className="chat-resource-toolbar-summary" title={summary}>{summary}</span>
      <button type="button" className="chat-resource-toolbar-primary" disabled={primary.disabled} aria-expanded={primary.expanded} aria-controls={primary.controls} onClick={primary.run}>{primary.label}</button>
      {actions.length || children ? <DropdownSelect compact floating placement="bottom" floatingMenuWidth={220} label={`Actions for ${name}`} value=""
        triggerContent={<MoreVertical size={15} />}
        options={[...choices.map((action, index) => ({ value: String(index), label: action.label, disabled: action.disabled })),
          ...(children ? [{ value: "details", label: details ? "Hide details" : "Details", separatorBefore: true }] : [])]}
        onChange={value => { if (value === "details") setDetails(open => !open); else choices[Number(value)]?.run(); }} /> : null}
    </header>
    {details && children ? <div className="chat-resource-details">{children}</div> : null}
  </>;
}
