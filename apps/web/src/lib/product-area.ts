import type { Experience, ProductArea } from "@openpond/contracts";
import type { AppView } from "./app-models";
import type { ChatTaskMode } from "./experience-options";

export const LAST_CHAT_TASK_MODE_STORAGE_KEY = "openpond:last-chat-task-mode";

type ChatTaskModeStorage = Pick<Storage, "getItem" | "setItem">;

export function productAreaForAppView(
  view: AppView,
  experience: Experience
): ProductArea {
  if (view === "labs") return "models";
  if (view === "chat") {
    return experience === "development" ? "development" : "chat";
  }
  if (view === "team" || view === "community") return "chat";
  if (view === "apps" || view === "profile") return "development";
  return experience === "development" ? "development" : "chat";
}

export function chatTaskModeForExperience(
  experience: Experience
): ChatTaskMode {
  return experience === "work" ? "work" : "chat";
}

export function readLastChatTaskMode(
  storage: Pick<ChatTaskModeStorage, "getItem">
): ChatTaskMode {
  try {
    return storage.getItem(LAST_CHAT_TASK_MODE_STORAGE_KEY) === "work"
      ? "work"
      : "chat";
  } catch {
    return "chat";
  }
}

export function readLastChatTaskModeFromBrowser(): ChatTaskMode {
  if (typeof window === "undefined") return "chat";
  try {
    return readLastChatTaskMode(window.localStorage);
  } catch {
    return "chat";
  }
}

export function rememberLastChatTaskMode(
  storage: Pick<ChatTaskModeStorage, "setItem">,
  experience: Experience
): void {
  if (experience === "development") return;
  try {
    storage.setItem(LAST_CHAT_TASK_MODE_STORAGE_KEY, experience);
  } catch {
    // Browser storage can be unavailable in restricted contexts.
  }
}

export function rememberLastChatTaskModeInBrowser(
  experience: Experience
): void {
  if (typeof window === "undefined") return;
  try {
    rememberLastChatTaskMode(window.localStorage, experience);
  } catch {
    // Browser storage can be unavailable in restricted contexts.
  }
}
