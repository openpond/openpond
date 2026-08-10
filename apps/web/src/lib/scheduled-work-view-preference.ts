export type ScheduledWorkViewMode = "calendar" | "list";

const STORAGE_KEY = "openpond.scheduled-work.view.v1";

export function readScheduledWorkViewMode(
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
): ScheduledWorkViewMode {
  try {
    return storage?.getItem(STORAGE_KEY) === "list" ? "list" : "calendar";
  } catch {
    return "calendar";
  }
}

export function writeScheduledWorkViewMode(
  mode: ScheduledWorkViewMode,
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, mode);
  } catch {
    // Preferences should never prevent the page from changing views.
  }
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
