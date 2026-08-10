import type { Session } from "@openpond/contracts";

const TASK_DRAFT_METADATA_KEY = "taskDraft";

type TaskDraftMetadata = {
  version: 1;
  prompt: string;
  savedAt: string;
};

export function taskDraftPrompt(
  session: Pick<Session, "experience" | "metadata"> | null | undefined
): string | null {
  if (session?.experience !== "work") return null;
  const value = session.metadata?.[TASK_DRAFT_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prompt = (value as Record<string, unknown>).prompt;
  return typeof prompt === "string" && prompt.trim() ? prompt : null;
}

export function isTaskDraftSession(
  session: Pick<Session, "experience" | "metadata"> | null | undefined
): boolean {
  return taskDraftPrompt(session) !== null;
}

export function taskDraftTitle(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  return (firstLine || "Task draft").slice(0, 64);
}

export function withTaskDraftMetadata(
  metadata: Record<string, unknown> | null | undefined,
  prompt: string,
  savedAt = new Date().toISOString()
): Record<string, unknown> {
  const taskDraft: TaskDraftMetadata = {
    version: 1,
    prompt,
    savedAt,
  };
  return {
    ...(metadata ?? {}),
    [TASK_DRAFT_METADATA_KEY]: taskDraft,
  };
}

export function withoutTaskDraftMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  delete next[TASK_DRAFT_METADATA_KEY];
  return next;
}
