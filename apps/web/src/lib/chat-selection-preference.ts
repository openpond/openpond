import type { ChatProvider, ProviderSettings } from "@openpond/contracts";
import { ClientChoicesSchema } from "@openpond/persistence/schemas/client-state";
import { normalizeChatModel } from "./app-models";
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

export function preferredChatModel(provider: ChatProvider, settings?: ProviderSettings | null): string {
  const saved = readChatSelectionPreference();
  const model = saved?.modelsByProvider?.[provider] ?? (saved?.provider === provider ? saved.model : undefined);
  return normalizeChatModel(provider, model, settings);
}

// Only explicit composer choices are remembered; opening a session keeps its own model.
export function rememberChatSelection(provider: ChatProvider, model: string): void {
  const saved = readChatSelectionPreference();
  const modelsByProvider = {
    ...(saved ? { [saved.provider]: saved.model } : {}),
    ...saved?.modelsByProvider,
    [provider]: model,
  };
  clientChoiceStorage.setItem(CHAT_SELECTION_KEY, JSON.stringify({ provider, model, modelsByProvider }));
}
