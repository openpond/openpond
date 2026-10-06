import { object } from "../connected-evidence/normalize.js";

function titleText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/\s+/gu, " ").trim().slice(0, 160) || null;
}

/** Retained provider titles take precedence over a preview of the first real user prompt. */
export function claudeConversationTitle(rows: readonly Record<string, unknown>[], sessionId: string): string {
  const owned = rows.filter((row) => row.sessionId === undefined || row.sessionId === sessionId);
  for (const row of [...owned].reverse()) {
    if (row.type === "custom-title") {
      const title = titleText(row.customTitle);
      if (title) return title;
    }
  }
  for (const row of [...owned].reverse()) {
    if (row.type === "summary") {
      const title = titleText(row.summary);
      if (title) return title;
    }
  }
  for (const row of owned) {
    if (row.type !== "user" || row.sessionId !== sessionId || row.isMeta || row.isSidechain) continue;
    const content = object(row.message).content;
    const title = titleText(Array.isArray(content)
      ? content.filter((part) => object(part).type === "text").map((part) => object(part).text).filter((part) => typeof part === "string").join(" ")
      : content);
    if (title) return title;
  }
  return sessionId;
}

export function retainedConversationTitle(value: unknown, sessionId: string): string {
  return titleText(value) ?? sessionId;
}
