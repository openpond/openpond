import { AppRuntimeView } from "./app/AppRuntimeView";
import { useAppPrimaryRuntime } from "./app/useAppPrimaryRuntime";
import { useAppSecondaryRuntime } from "./app/useAppSecondaryRuntime";

export function App() {
  const primary = useAppPrimaryRuntime();
  const secondary = useAppSecondaryRuntime(primary);
  return <AppRuntimeView primary={primary} secondary={secondary} />;
}
