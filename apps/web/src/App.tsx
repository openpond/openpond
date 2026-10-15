import { createWorkspaceQueryClient } from "./lib/query-client";
import { AppRuntimeView } from "./app/AppRuntimeView";
import { QueryClientProvider } from "@tanstack/react-query";
import { useAppPrimaryRuntime } from "./app/useAppPrimaryRuntime";
import { useAppSecondaryRuntime } from "./app/useAppSecondaryRuntime";
import { DesktopGettingStarted } from "./components/onboarding/DesktopGettingStarted";
import { useAppStartupProgress } from "./components/splash/AppStartupBoundary";

const queries = createWorkspaceQueryClient();

export function App() {
  return <QueryClientProvider client={queries}><AppRuntime /></QueryClientProvider>;
}

function AppRuntime() {
  const primary = useAppPrimaryRuntime();
  const secondary = useAppSecondaryRuntime(primary);
  useAppStartupProgress(primary.startup);
  return <>
    <AppRuntimeView primary={primary} secondary={secondary} />
    <DesktopGettingStarted ready={primary.startup.ready} connection={primary.connection}
      payload={primary.bootstrap} onPayload={primary.applyBootstrapPayload} />
  </>;
}
