export type InsertVoiceTranscriptResult = {
  value: string;
  cursorIndex: number;
};

export function insertVoiceTranscript(
  currentValue: string,
  transcript: string,
  cursorIndex: number,
): InsertVoiceTranscriptResult {
  const text = transcript.trim().replace(/\s+/g, " ");
  const cursor = clampCursor(cursorIndex, currentValue.length);
  if (!text) return { value: currentValue, cursorIndex: cursor };

  const before = currentValue.slice(0, cursor);
  const after = currentValue.slice(cursor);
  const leading = before && !/\s$/.test(before) ? " " : "";
  const trailing = after && !/^\s/.test(after) ? " " : "";
  const insertion = `${leading}${text}${trailing}`;
  return {
    value: `${before}${insertion}${after}`,
    cursorIndex: before.length + leading.length + text.length + trailing.length,
  };
}

function clampCursor(cursorIndex: number, length: number): number {
  if (!Number.isFinite(cursorIndex)) return length;
  return Math.max(0, Math.min(length, Math.round(cursorIndex)));
}
