import { insertVoiceTranscript } from "./voice-text";

export type VoiceTranscriptDelivery = "drafted" | "submitted" | "retained";

export async function deliverVoiceTranscript({
  appendToEnd = false,
  currentScopeKey,
  cursorIndex,
  originScopeKey,
  prompt,
  setOriginDraft,
  submitFromOrigin,
  transcript,
}: {
  appendToEnd?: boolean;
  currentScopeKey: string;
  cursorIndex: number;
  originScopeKey: string;
  prompt: string;
  setOriginDraft: (value: string) => void;
  submitFromOrigin: (prompt: string) => Promise<boolean>;
  transcript: string;
}): Promise<VoiceTranscriptDelivery> {
  const next = insertVoiceTranscript(
    prompt,
    transcript,
    appendToEnd ? prompt.length : cursorIndex,
  );
  setOriginDraft(next.value);
  if (currentScopeKey === originScopeKey) return "drafted";

  const sent = await submitFromOrigin(next.value);
  if (!sent) return "retained";
  setOriginDraft("");
  return "submitted";
}
