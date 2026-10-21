import type { ChatAttachment, TaskResourceContext } from "@openpond/contracts";
export type ComposerSteerDraft = {
  attachments?: ChatAttachment[];
  resourceContexts?: TaskResourceContext[];
  createdAt: string;
  id: string;
  prompt: string;
  updatedAt: string;
};

export type ComposerSteerDraftScopeState = Record<string, ComposerSteerDraft[]>;

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
  options: { id?: string; now?: string; resourceContexts?: TaskResourceContext[]; attachments?: ChatAttachment[] } = {},
): ComposerSteerDraft {
  const now = options.now ?? new Date().toISOString();
  return {
    ...(options.resourceContexts ? { resourceContexts: structuredClone(options.resourceContexts) } : {}),
    ...(options.attachments?.length ? { attachments: structuredClone(options.attachments) } : {}),
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

export function composerSteerDraftsAfterSubmit(
  drafts: ComposerSteerDraft[],
  draftId: string,
  sent: boolean,
): ComposerSteerDraft[] {
  return sent ? removeComposerSteerDraft(drafts, draftId) : drafts;
}

export function composerSteerDraftsForScope(
  draftsByScope: ComposerSteerDraftScopeState,
  scopeKey: string,
  initialDrafts: ComposerSteerDraft[] = [],
): ComposerSteerDraft[] {
  return draftsByScope[scopeKey] ?? initialDrafts;
}

export function updateComposerSteerDraftScope(
  draftsByScope: ComposerSteerDraftScopeState,
  scopeKey: string,
  updateDrafts: (drafts: ComposerSteerDraft[]) => ComposerSteerDraft[],
  initialDrafts: ComposerSteerDraft[] = [],
): ComposerSteerDraftScopeState {
  const currentDrafts = composerSteerDraftsForScope(draftsByScope, scopeKey, initialDrafts);
  const nextDrafts = updateDrafts(currentDrafts);
  if (Object.is(currentDrafts, nextDrafts)) return draftsByScope;
  return {
    ...draftsByScope,
    [scopeKey]: nextDrafts,
  };
}
