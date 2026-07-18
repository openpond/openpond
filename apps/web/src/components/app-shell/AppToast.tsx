import type { AppToast as AppToastModel } from "../../app/app-state";
import { Settings, X } from "../icons";

type AppToastProps = {
  toast: AppToastModel | null;
  onDismiss: () => void;
};

export function AppToast({ toast, onDismiss }: AppToastProps) {
  if (!toast) return null;

  const hasAction = Boolean(toast.actionLabel && toast.onAction);
  const canDismiss = Boolean(toast.persistent || toast.dismissible);

  return (
    <div className={`app-toast ${toast.tone} ${toast.placement ?? "bottom-right"}`} role={toast.tone === "error" ? "alert" : "status"} aria-live="polite">
      <span className="app-toast-message">{toast.message}</span>
      {(hasAction || canDismiss) && (
        <div className="app-toast-actions">
          {hasAction && (
            <button
              type="button"
              className={toast.actionIcon ? "app-toast-icon-action" : undefined}
              aria-label={toast.actionLabel}
              title={toast.actionIcon ? toast.actionLabel : undefined}
              onClick={() => {
                onDismiss();
                toast.onAction?.();
              }}
            >
              {toast.actionIcon === "settings" ? <Settings size={15} /> : toast.actionLabel}
            </button>
          )}
          {canDismiss && (
            <button type="button" className="app-toast-close" aria-label="Dismiss notification" onClick={onDismiss}>
              <X size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
