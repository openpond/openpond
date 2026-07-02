import { useCallback, useEffect, useState } from "react";

export type ProjectConfirmDialogRequest = {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
};

export type ProjectConfirmDialogState = ProjectConfirmDialogRequest & {
  resolve: (confirmed: boolean) => void;
};

export function useProjectConfirmDialog() {
  const [projectConfirmDialog, setProjectConfirmDialog] = useState<ProjectConfirmDialogState | null>(null);
  const confirmProjectAction = useCallback(
    (request: ProjectConfirmDialogRequest) =>
      new Promise<boolean>((resolve) => {
        setProjectConfirmDialog({
          ...request,
          cancelLabel: request.cancelLabel ?? "Cancel",
          resolve,
        });
      }),
    [],
  );
  const resolveProjectConfirmDialog = useCallback((confirmed: boolean) => {
    setProjectConfirmDialog((current) => {
      current?.resolve(confirmed);
      return null;
    });
  }, []);

  return {
    confirmProjectAction,
    projectConfirmDialog,
    resolveProjectConfirmDialog,
  };
}

export function ProjectConfirmDialog({
  state,
  onResolve,
}: {
  state: ProjectConfirmDialogState | null;
  onResolve: (confirmed: boolean) => void;
}) {
  useEffect(() => {
    if (!state) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onResolve(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onResolve, state]);

  if (!state) return null;

  return (
    <div className="git-dialog-backdrop" role="presentation" onMouseDown={() => onResolve(false)}>
      <section
        className="git-dialog project-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="project-confirm-title"
        aria-describedby="project-confirm-body"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="project-confirm-title">{state.title}</h2>
        <p id="project-confirm-body">{state.body}</p>
        <div className="git-dialog-footer">
          <button type="button" className="git-dialog-secondary" onClick={() => onResolve(false)}>
            {state.cancelLabel ?? "Cancel"}
          </button>
          <button type="button" className="git-dialog-primary danger" autoFocus onClick={() => onResolve(true)}>
            {state.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
