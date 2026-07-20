import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { AppAction, AppToast, ShowAppToast } from "../app/app-state";
import { api, type ClientConnection } from "../api";
import { errorMessageForToast } from "../lib/error-messages";

export function useAppErrorReporter({
  appDispatch,
  error,
  setErrorState,
}: {
  appDispatch: Dispatch<AppAction>;
  error: string | null;
  setErrorState: Dispatch<SetStateAction<string | null>>;
}) {
  const connectionRef = useRef<ClientConnection | null>(null);
  const latestErrorRef = useRef<string | null>(null);
  const errorToastIdRef = useRef<number | null>(null);
  const toastSequenceRef = useRef(0);

  const showToast = useCallback<ShowAppToast>(
    (
      message: string,
      tone: "success" | "error" | "info" = "info",
      options: Pick<
        AppToast,
        | "actionLabel"
        | "actionIcon"
        | "onAction"
        | "persistent"
        | "dismissible"
        | "durationMs"
        | "placement"
      > = {},
    ) => {
      const id = Date.now() + ++toastSequenceRef.current;
      appDispatch({ type: "showToast", toast: { id, message, tone, ...options } });
      return id;
    },
    [appDispatch],
  );
  const openDiagnosticsSettings = useCallback(() => {
    appDispatch({
      type: "patch",
      patch: {
        settingsSection: "diagnostics",
        sidebarOpen: true,
        view: "settings",
      },
    });
  }, [appDispatch]);
  const setError = useCallback<Dispatch<SetStateAction<string | null>>>(
    (value) => {
      const current = latestErrorRef.current;
      const next = typeof value === "function" ? value(current) : value;
      if (Object.is(current, next)) return;

      latestErrorRef.current = next;
      setErrorState(next);
      if (!next) {
        if (errorToastIdRef.current !== null) {
          appDispatch({ type: "clearToast", toastId: errorToastIdRef.current });
          errorToastIdRef.current = null;
        }
        return;
      }

      errorToastIdRef.current = showToast(appErrorToastMessage(next), "error", {
        actionLabel: "Open diagnostics settings",
        actionIcon: "settings",
        onAction: openDiagnosticsSettings,
        dismissible: true,
      });
      const connection = connectionRef.current;
      if (!connection) return;
      void api
        .recordClientDiagnostic(connection, {
          message: next,
          surface: "app",
          context: { href: window.location.href },
        })
        .catch((diagnosticError) => {
          console.warn("Unable to record client diagnostic.", diagnosticError);
        });
    },
    [appDispatch, openDiagnosticsSettings, setErrorState, showToast],
  );

  useEffect(() => {
    latestErrorRef.current = error;
    if (error || errorToastIdRef.current === null) return;
    appDispatch({ type: "clearToast", toastId: errorToastIdRef.current });
    errorToastIdRef.current = null;
  }, [appDispatch, error]);

  return { connectionRef, setError, showToast };
}

export function appErrorToastMessage(message: string): string {
  return errorMessageForToast(message);
}
