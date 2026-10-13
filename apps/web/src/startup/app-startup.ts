export type AppStartupStageId = "connecting" | "account" | "ready";

export type AppStartupState = {
  error?: string | null;
  retrying?: boolean;
  retry?: () => void;
  label: string;
  ready: boolean;
  stage: AppStartupStageId;
};

const APP_STARTUP_LABELS: Record<AppStartupStageId, string> = {
  connecting: "Connecting to OpenPond",
  account: "Loading account",
  ready: "Ready",
};

export function appStartupState(stage: AppStartupStageId): AppStartupState {
  return {
    label: APP_STARTUP_LABELS[stage],
    ready: stage === "ready",
    stage,
  };
}
