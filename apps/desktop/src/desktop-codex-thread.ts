/** The renderer can open one Codex chat, never supply an arbitrary custom URL. */
export function codexThreadUrl(payload: unknown): string {
  const threadId =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).threadId
      : null;
  if (
    typeof threadId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)
  ) {
    throw new Error("Invalid Codex thread ID.");
  }
  return `codex://threads/${threadId}`;
}
