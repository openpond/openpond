export const ONBOARDING_STORAGE_KEY = "openpond:desktop-get-started:v1";
export const OPEN_ONBOARDING_EVENT = "openpond:open-get-started";

export function openGettingStarted() {
  window.dispatchEvent(new Event(OPEN_ONBOARDING_EVENT));
}

// Wait for the app to settle, and never open a second modal over an active one.
// The caller cancels this schedule on disconnect, scope change, or unmount.
export function scheduleGettingStarted(open: () => void, blocked: () => boolean): () => void {
  let timer = setTimeout(attempt, 5_000);
  function attempt() {
    if (blocked()) timer = setTimeout(attempt, 500);
    else open();
  }
  return () => clearTimeout(timer);
}
