import { useCallback } from "react";
import {
  ConfirmDialog,
  type ConfirmDialogRequest,
  type ConfirmDialogState,
  useConfirmDialog,
} from "../common/ConfirmDialog";

export type ProjectConfirmDialogRequest = ConfirmDialogRequest;
export type ProjectConfirmDialogState = ConfirmDialogState;

export function useProjectConfirmDialog() {
  const { confirmAction, confirmDialog, resolveConfirmDialog } = useConfirmDialog();
  const confirmProjectAction = useCallback(
    (request: ProjectConfirmDialogRequest) =>
      confirmAction({
        tone: "danger",
        ...request,
      }),
    [confirmAction],
  );

  return {
    confirmProjectAction,
    projectConfirmDialog: confirmDialog,
    resolveProjectConfirmDialog: resolveConfirmDialog,
  };
}

export function ProjectConfirmDialog({
  state,
  onResolve,
}: {
  state: ProjectConfirmDialogState | null;
  onResolve: (confirmed: boolean) => void;
}) {
  return <ConfirmDialog state={state} onResolve={onResolve} />;
}
