export type SidebarTaskVisibilityPreferences = {
  showCodexChats: boolean;
  onlyRunningTasks: boolean;
};

export const DEFAULT_SIDEBAR_TASK_VISIBILITY_PREFERENCES: SidebarTaskVisibilityPreferences = {
  showCodexChats: true,
  onlyRunningTasks: false,
};

export const SIDEBAR_TASK_VISIBILITY_STORAGE_KEY =
  "openpond.sidebar-task-visibility.v1";

export function readSidebarTaskVisibilityPreferences(
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
): SidebarTaskVisibilityPreferences {
  try {
    const value = storage?.getItem(SIDEBAR_TASK_VISIBILITY_STORAGE_KEY);
    if (!value) return DEFAULT_SIDEBAR_TASK_VISIBILITY_PREFERENCES;
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      showCodexChats:
        typeof parsed.showCodexChats === "boolean"
          ? parsed.showCodexChats
          : DEFAULT_SIDEBAR_TASK_VISIBILITY_PREFERENCES.showCodexChats,
      onlyRunningTasks:
        typeof parsed.onlyRunningTasks === "boolean"
          ? parsed.onlyRunningTasks
          : DEFAULT_SIDEBAR_TASK_VISIBILITY_PREFERENCES.onlyRunningTasks,
    };
  } catch {
    return DEFAULT_SIDEBAR_TASK_VISIBILITY_PREFERENCES;
  }
}

export function writeSidebarTaskVisibilityPreferences(
  preferences: SidebarTaskVisibilityPreferences,
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
): void {
  try {
    storage?.setItem(
      SIDEBAR_TASK_VISIBILITY_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch {
    // A blocked or full browser store should not prevent sidebar filtering.
  }
}

function browserStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}
