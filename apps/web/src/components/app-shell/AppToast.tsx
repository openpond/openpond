import type { AppToast as AppToastModel } from "../../app/app-state";

type AppToastProps = {
  toast: AppToastModel | null;
  onDismiss: () => void;
};

export function AppToast({ toast, onDismiss }: AppToastProps) {
  if (!toast) return null;

  return (
    <div className={`app-toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"} aria-live="polite">
      <span>{toast.message}</span>
      {toast.actionLabel && toast.onAction && (
        <button
          type="button"
          onClick={() => {
            onDismiss();
            toast.onAction?.();
          }}
        >
          {toast.actionLabel}
        </button>
      )}
      {toast.persistent && (
        <button type="button" className="app-toast-close" aria-label="Dismiss notification" onClick={onDismiss}>
          x
        </button>
      )}
    </div>
  );
}
