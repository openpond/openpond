import type { ReactNode } from "react";

import { AppDialog } from "../dialogs/AppDialog";
import { ArrowLeft, X } from "../icons";
import type { NewModelStep } from "../training/training-flow";

export function CreateImproveAuthoringShell({
  ariaLabel,
  backAriaLabel,
  children,
  presentation,
  showBack,
  step,
  title,
  onBack,
  onClose,
}: {
  ariaLabel: string;
  backAriaLabel: string;
  children: ReactNode;
  presentation: "dialog" | "embedded";
  showBack: boolean;
  step: NewModelStep;
  title: string;
  onBack: () => void;
  onClose: () => void;
}) {
  if (presentation === "embedded") {
    return (
      <section className="labs-dataset-build-editor" aria-label={ariaLabel}>
        {showBack ? (
          <button
            className="training-text-button labs-dataset-build-back"
            type="button"
            onClick={onBack}
          >
            <ArrowLeft size={14} />
            {backAriaLabel}
          </button>
        ) : null}
        <div className="labs-dataset-builder-workspace">{children}</div>
      </section>
    );
  }

  return (
    <AppDialog
      ariaLabel={ariaLabel}
      className={`training-dialog training-run-dialog ${step === "start" ? "training-run-start-step" : "training-run-workflow-step"}`}
      initialFocusKey={step}
      onClose={onClose}
    >
      <div className="training-dialog-header">
        <div className="training-run-dialog-title">
          {showBack ? (
            <button
              className="training-icon-button"
              type="button"
              aria-label={backAriaLabel}
              onClick={onBack}
            >
              <ArrowLeft size={16} />
            </button>
          ) : null}
          <h2>{title}</h2>
        </div>
        <button className="training-icon-button" type="button" aria-label="Close" onClick={onClose}><X size={16} /></button>
      </div>
      {children}
    </AppDialog>
  );
}
