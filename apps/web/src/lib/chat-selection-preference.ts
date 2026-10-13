import type { ChatProvider } from "@openpond/contracts";
import { ClientChoicesSchema } from "@openpond/persistence/schemas/client-state";
import { clientChoiceStorage } from "./client-choice-storage";

export const CHAT_SELECTION_KEY = "openpond:last-chat-selection";

export function readChatSelectionPreference() {
  const saved = clientChoiceStorage.getItem(CHAT_SELECTION_KEY);
  if (!saved) return null;
  try {
    return ClientChoicesSchema.parse({ chatSelection: JSON.parse(saved) }).chatSelection ?? null;
  } catch {
    return null;
  }
}

// Only explicit composer choices are remembered; opening a session keeps its own model.
export function rememberChatSelection(provider: ChatProvider, model: string): void {
  clientChoiceStorage.setItem(CHAT_SELECTION_KEY, JSON.stringify({ provider, model }));
}
