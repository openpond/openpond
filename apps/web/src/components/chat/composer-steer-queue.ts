export type ComposerSteerDraft = {
  createdAt: string;
  id: string;
  prompt: string;
  updatedAt: string;
};

export type ComposerSteerAutoDispatchInput = {
  autoDispatchReady: boolean;
  hasQueuedDrafts: boolean;
  running: boolean;
  sending: boolean;
  waitingForStartedTurn: boolean;
  wasRunning: boolean;
};

export type ComposerSteerEditTarget = "dialog" | "load_composer";

export type ComposerSteerEditTargetInput = {
  attachmentCount: number;
  hasSelectedAction: boolean;
  hasSelectedCommand: boolean;
  prompt: string;
};

function nextSteerDraftId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `steer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function composerSteerPreview(prompt: string, maxLength = 120): string {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

export function createComposerSteerDraft(
  prompt: string,
  options: { id?: string; now?: string } = {},
): ComposerSteerDraft {
  const now = options.now ?? new Date().toISOString();
  return {
    createdAt: now,
    id: options.id ?? nextSteerDraftId(),
    prompt,
    updatedAt: now,
  };
}

export function removeComposerSteerDraft(
  drafts: ComposerSteerDraft[],
  draftId: string,
): ComposerSteerDraft[] {
  return drafts.filter((draft) => draft.id !== draftId);
}

export function updateComposerSteerDraft(
  drafts: ComposerSteerDraft[],
  draftId: string,
  prompt: string,
  now = new Date().toISOString(),
): ComposerSteerDraft[] {
  return drafts.map((draft) =>
    draft.id === draftId
      ? {
          ...draft,
          prompt,
          updatedAt: now,
        }
      : draft,
  );
}

export function composerSteerDraftsAfterSubmit(
  drafts: ComposerSteerDraft[],
  draftId: string,
  sent: boolean,
): ComposerSteerDraft[] {
  return sent ? removeComposerSteerDraft(drafts, draftId) : drafts;
}

export function composerSteerEditTarget(input: ComposerSteerEditTargetInput): ComposerSteerEditTarget {
  return input.prompt.trim() || input.attachmentCount > 0 || input.hasSelectedAction || input.hasSelectedCommand
    ? "dialog"
    : "load_composer";
}

export function shouldAutoDispatchComposerSteer(input: ComposerSteerAutoDispatchInput): boolean {
  return (
    input.wasRunning &&
    !input.running &&
    input.autoDispatchReady &&
    input.hasQueuedDrafts &&
    !input.sending &&
    !input.waitingForStartedTurn
  );
}
