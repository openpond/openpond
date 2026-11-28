import { createContext, useContext, useId, useRef } from "react";
import type { SessionResourceDraftKind } from "@openpond/contracts/requests";
import type { ResourceSetupCandidate } from "../../lib/resource-setup-prompt";
import { Boxes, ChevronDown, FileSpreadsheet, MessageSquare, Plus, Shield, Target } from "../icons";
import "./desktop-new-menu.css";

export type DesktopNewKind = "chat" | SessionResourceDraftKind;

export const DesktopNewContext = createContext<{
  busy: boolean;
  managedAvailable: boolean;
  create(kind: DesktopNewKind, candidate?: ResourceSetupCandidate): void;
} | null>(null);

const entries = [
  { kind: "chat", label: "Chat", Icon: MessageSquare },
  { kind: "model", label: "Model", Icon: Boxes },
  { kind: "benchmark", label: "Benchmark", Icon: Target },
  { kind: "dataset", label: "Dataset", Icon: FileSpreadsheet },
  { kind: "grader", label: "Grader", Icon: Shield },
] as const;

export function DesktopNewResourceButton({ kind }: { kind: SessionResourceDraftKind }) {
  const action = useContext(DesktopNewContext);
  return action ? <button type="button" className="training-button" disabled={action.busy}
    onClick={() => action.create(kind)}>New {kind}</button> : null;
}

export function DesktopNewMenu({ sidebar = false }: { sidebar?: boolean }) {
  const action = useContext(DesktopNewContext);
  const id = useId();
  const popover = useRef<HTMLDivElement>(null);
  if (!action) return null;
  return <div className={sidebar ? "desktop-new sidebar-desktop-new" : "desktop-new"}>
    <button type="button" className={sidebar ? "sidebar-row desktop-new-trigger" : "training-button desktop-new-trigger"}
      popoverTarget={id} disabled={action.busy}>
      <Plus aria-hidden="true" size={15} /> <span>New</span> <ChevronDown aria-hidden="true" size={13} />
    </button>
    <div id={id} ref={popover} popover="auto" className="desktop-new-popover" role="group" aria-label="Create new">
      {/* Keep the trigger focused through pointer selection so the sidebar menu stays anchored. */}
      {entries.map(({ kind, label, Icon }) => <button key={kind} type="button"
        onMouseDown={event => event.preventDefault()} onClick={() => {
        popover.current?.hidePopover();
        action.create(kind);
      }}>
        <Icon aria-hidden="true" size={15} /> {label}
      </button>)}
    </div>
  </div>;
}
