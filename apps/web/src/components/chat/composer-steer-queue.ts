export type ComposerSteerDraft = {
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

export function replaceComposerSteerDraftForEdit(
  drafts: ComposerSteerDraft[],
  draftId: string,
  displacedComposerPrompt?: string,
): ComposerSteerDraft[] {
  const displacedPrompt = displacedComposerPrompt?.trim();
  return drafts.flatMap((draft) => {
    if (draft.id !== draftId) return [draft];
    return displacedPrompt ? [createComposerSteerDraft(displacedPrompt)] : [];
  });
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
