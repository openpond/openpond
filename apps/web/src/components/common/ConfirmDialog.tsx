import { useCallback, useEffect, useId, useRef, useState } from "react";

export type ConfirmDialogTone = "default" | "danger";

export type ConfirmDialogRequest = {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: ConfirmDialogTone;
};

export type ConfirmDialogState = ConfirmDialogRequest & {
  cancelLabel: string;
  tone: ConfirmDialogTone;
  resolve: (confirmed: boolean) => void;
};

export function useConfirmDialog() {
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const confirmDialogRef = useRef<ConfirmDialogState | null>(null);
  const confirmAction = useCallback(
    (request: ConfirmDialogRequest) =>
      new Promise<boolean>((resolve) => {
        confirmDialogRef.current?.resolve(false);
        const nextDialog = {
          ...request,
          cancelLabel: request.cancelLabel ?? "Cancel",
          tone: request.tone ?? "default",
          resolve,
        };
        confirmDialogRef.current = nextDialog;
        setConfirmDialog(nextDialog);
      }),
    [],
  );
  const resolveConfirmDialog = useCallback((confirmed: boolean) => {
    const current = confirmDialogRef.current;
    confirmDialogRef.current = null;
    setConfirmDialog(null);
    current?.resolve(confirmed);
  }, []);

  return {
    confirmAction,
    confirmDialog,
    resolveConfirmDialog,
  };
}

export function ConfirmDialog({
  state,
  onResolve,
}: {
  state: ConfirmDialogState | null;
  onResolve: (confirmed: boolean) => void;
}) {
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    if (!state) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onResolve(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onResolve, state]);

  if (!state) return null;

  const confirmClassName = state.tone === "danger" ? "git-dialog-primary danger" : "git-dialog-primary";

  return (
    <div className="git-dialog-backdrop" role="presentation" onMouseDown={() => onResolve(false)}>
      <section
        className="git-dialog project-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId}>{state.title}</h2>
        <p id={bodyId}>{state.body}</p>
        <div className="git-dialog-footer">
          <button type="button" className="git-dialog-secondary" onClick={() => onResolve(false)}>
            {state.cancelLabel}
          </button>
          <button type="button" className={confirmClassName} autoFocus onClick={() => onResolve(true)}>
            {state.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
