import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { appStartupState, type AppStartupState } from "../../startup/app-startup";
import { AppSplash } from "./AppSplash";

const StartupContext = createContext<((startup: AppStartupState) => void) | null>(null);

/** Own the splash above Suspense so loading the app cannot restart its animation. */
export function AppStartupBoundary({ children }: { children: ReactNode }) {
  const [startup, setStartup] = useState(() => appStartupState("connecting"));
  return (
    <StartupContext.Provider value={setStartup}>
      {!startup.ready ? <AppSplash startup={startup} /> : null}
      {children}
    </StartupContext.Provider>
  );
}

export function useAppStartupProgress(startup: AppStartupState) {
  const reportStartup = useContext(StartupContext);
  const { stage, label, ready, error, retrying, retry } = startup;
  // Commit readiness and recovery controls before paint, alongside the app view.
  useLayoutEffect(() => {
    reportStartup?.({ stage, label, ready, error, retrying, retry });
  }, [reportStartup, stage, label, ready, error, retrying, retry]);
}
