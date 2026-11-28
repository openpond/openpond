import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { AppDialog } from "../dialogs/AppDialog";
import { X } from "../icons";
import "./model-serving-dialog.css";

export function ModelServingDialog({ ariaLabel, children, dismissDisabled, onClose }: {
  ariaLabel: string;
  children: ReactNode;
  dismissDisabled?: boolean;
  onClose(): void;
}) {
  return createPortal(
    <AppDialog ariaLabel={ariaLabel} className="model-serving-dialog" backdropClassName="model-serving-backdrop"
      dismissDisabled={dismissDisabled} onClose={onClose}>
      <button className="model-serving-close" type="button" aria-label="Close serving review"
        disabled={dismissDisabled} onClick={onClose}><X size={16} aria-hidden="true" /></button>
      {children}
    </AppDialog>,
    document.body,
  );
}
