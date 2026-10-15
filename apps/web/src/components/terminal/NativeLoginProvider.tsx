import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { ProviderSettings } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { useAppToast, useErrorToast } from "../../app/AppToastContext";
import type { NativeProviderCheck } from "../settings/native-provider-check";
import type { TerminalSetupCommand } from "./terminal-overlay-types";
import { NativeBrowserLogin } from "./NativeBrowserLogin";

type NativeLogin = { active: boolean; result: NativeProviderCheck | null; start(command: TerminalSetupCommand): void; resume(): void };
const NativeLoginContext = createContext<NativeLogin | null>(null);

/** Shell ownership lets login continue after onboarding/settings are closed. */
export function NativeLoginProvider({ connection, onProviders, children }: {
  connection: ClientConnection | null;
  onProviders(settings: ProviderSettings): void;
  children: ReactNode;
}) {
  const key = connection ? JSON.stringify([connection.serverUrl, connection.token]) : null;
  const [session, setSession] = useState<{ id: string; key: string; connection: ClientConnection; command: TerminalSetupCommand } | null>(null);
  const [verification, setVerification] = useState<{ key: string; result: NativeProviderCheck } | null>(null);
  const result = verification?.key === key ? verification.result : null;
  const [openRequest, setOpenRequest] = useState(0);
  const check = useRef<AbortController | null>(null);
  const latestProviders = useRef(onProviders);
  latestProviders.current = onProviders;
  const showToast = useAppToast();
  const [error, setError] = useState<string | null>(null);
  useErrorToast(error, { prefix: "Claude connection" });
  const active = session?.key === key && session !== null;
  useEffect(() => {
    setSession(null);
    setVerification(null);
    setError(null);
    return () => { check.current?.abort(); check.current = null; };
  }, [key]);

  const start = useCallback((command: TerminalSetupCommand) => {
    if (!connection || !key) return;
    check.current?.abort();
    setError(null);
    setVerification(null);
    setSession(current => current?.key === key ? current : { id: crypto.randomUUID(), key, connection, command });
    setOpenRequest(current => current + 1);
  }, [connection, key]);
  const resume = useCallback(() => setOpenRequest(current => current + 1), []);

  async function finish() {
    if (!session || session.key !== key) return;
    setSession(null);
    const controller = new AbortController();
    check.current?.abort();
    check.current = controller;
    try {
      const result = await apiFetch<NativeProviderCheck>(session.connection, "/v1/providers/claude-code/native-setup", {
        method: "POST", body: JSON.stringify({ action: "check" }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]),
      });
      if (controller.signal.aborted) return;
      setVerification({ key: session.key, result });
      latestProviders.current(result.settings);
      if (result.status === "ready") showToast?.("Claude connected.", "success");
      else setError(result.error ?? "Claude sign-in could not be verified. Refresh the connection in Settings.");
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not verify the Claude connection.");
    } finally {
      if (check.current === controller) check.current = null;
    }
  }

  return <NativeLoginContext.Provider value={{ active, result, start, resume }}>
    {children}
    {active && session ? <NativeBrowserLogin key={session.id} connection={session.connection} {...session.command} openRequest={openRequest} onClose={() => setSession(null)} onComplete={() => void finish()} /> : null}
  </NativeLoginContext.Provider>;
}

export function useNativeLogin(): NativeLogin {
  const value = useContext(NativeLoginContext);
  if (!value) throw new Error("Native login requires the app shell.");
  return value;
}
