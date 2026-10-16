import { useEffect, useRef, type ReactNode } from "react";

export function PonderSetupDialog({children, onClose}: {children: ReactNode; onClose(): void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="git-dialog ponder-setup" aria-labelledby="ponder-setup-title" onCancel={event => {event.preventDefault();onClose();}}>{children}</dialog>;
}
