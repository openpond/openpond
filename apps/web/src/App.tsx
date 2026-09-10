import { createWorkspaceQueryClient } from "./lib/query-client";
import { AppRuntimeView } from "./app/AppRuntimeView";
import { QueryClientProvider } from "@tanstack/react-query";
import { useAppPrimaryRuntime } from "./app/useAppPrimaryRuntime";
import { useAppSecondaryRuntime } from "./app/useAppSecondaryRuntime";

const queries = createWorkspaceQueryClient();

export function App() {
  return <QueryClientProvider client={queries}><AppRuntime /></QueryClientProvider>;
}

function AppRuntime() {
  const primary = useAppPrimaryRuntime();
  const secondary = useAppSecondaryRuntime(primary);
  return <AppRuntimeView primary={primary} secondary={secondary} />;
}
