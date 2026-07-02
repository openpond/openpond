export type AppStartupStageId = "connecting" | "account" | "team" | "ready";

export type AppStartupState = {
  label: string;
  ready: boolean;
  stage: AppStartupStageId;
};

const APP_STARTUP_LABELS: Record<AppStartupStageId, string> = {
  connecting: "Connecting to OpenPond",
  account: "Loading account",
  team: "Loading default team",
  ready: "Ready",
};

export function appStartupState(stage: AppStartupStageId): AppStartupState {
  return {
    label: APP_STARTUP_LABELS[stage],
    ready: stage === "ready",
    stage,
  };
}
