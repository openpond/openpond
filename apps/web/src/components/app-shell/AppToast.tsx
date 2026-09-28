import type { AppToast as AppToastModel } from "../../app/app-state";

type AppToastProps = {
  toast: AppToastModel | null;
  onDismiss: () => void;
};

export function AppToast({ toast, onDismiss }: AppToastProps) {
  if (!toast) return null;

  const hasAction = Boolean(toast.actionLabel && toast.onAction);

  return (
    <div className={`app-toast ${toast.tone} ${toast.placement ?? "bottom-right"}`} role={toast.tone === "error" ? "alert" : "status"} aria-live="polite">
      <span className="app-toast-message">{toast.message}</span>
      {hasAction && (
        <div className="app-toast-actions">
          <button
            type="button"
            aria-label={toast.actionLabel}
            onClick={() => {
              onDismiss();
              toast.onAction?.();
            }}
          >
            {toast.actionLabel}
          </button>
        </div>
      )}
    </div>
  );
}
