export const HARNESS_LEARNING_NOTICE_DISMISSED_KEY =
  "openpond.sidebar.continuous-learning.dismissed.v1";

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function readHarnessLearningNoticeDismissed(
  storage: PreferenceStorage | null = browserPreferenceStorage()
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(HARNESS_LEARNING_NOTICE_DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function rememberHarnessLearningNoticeDismissed(
  storage: PreferenceStorage | null = browserPreferenceStorage()
): void {
  if (!storage) return;
  try {
    storage.setItem(HARNESS_LEARNING_NOTICE_DISMISSED_KEY, "true");
  } catch {
    // The in-memory dismissal still applies when browser storage is blocked.
  }
}

function browserPreferenceStorage(): PreferenceStorage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}
