import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import type { ShowAppToast } from "./app-state";
import { errorMessageForToast } from "../lib/error-messages";

const AppToastContext = createContext<ShowAppToast | null>(null);

export function AppToastProvider({
  children,
  showToast,
}: {
  children: ReactNode;
  showToast: ShowAppToast;
}) {
  return (
    <AppToastContext.Provider value={showToast}>
      {children}
    </AppToastContext.Provider>
  );
}

export function useAppToast(): ShowAppToast | null {
  return useContext(AppToastContext);
}

export function useErrorToast(
  error: unknown,
  options: {
    enabled?: boolean;
    fallback?: string;
    prefix?: string;
  } = {},
): void {
  const showToast = useAppToast();
  const lastMessageRef = useRef<string | null>(null);
  const enabled = options.enabled ?? true;
  const fallback = options.fallback ?? "Something went wrong.";
  const prefix = options.prefix?.trim() ?? "";
  const message = error == null || error === ""
    ? null
    : `${prefix}${prefix ? ": " : ""}${errorMessageForToast(error, fallback)}`;

  useEffect(() => {
    if (!enabled || !message) {
      lastMessageRef.current = null;
      return;
    }
    if (lastMessageRef.current === message) return;
    lastMessageRef.current = message;
    showToast?.(message, "error", { dismissible: true });
  }, [enabled, message, showToast]);
}
