import type { ComposerAttachmentDraft } from "./ComposerAttachments";

export function createComposerAttachmentStore() {
  let attachments: ComposerAttachmentDraft[] = [];
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => attachments,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update(next: ComposerAttachmentDraft[] | ((current: ComposerAttachmentDraft[]) => ComposerAttachmentDraft[])) {
      const value = typeof next === "function" ? next(attachments) : next;
      if (Object.is(attachments, value)) return;
      attachments = value;
      for (const listener of listeners) listener();
    },
  };
}

// Keep File objects in memory with the draft owner, never in persisted choices.
// The full submission scope includes the account/workspace/chat boundary.
const owners = new WeakMap<object, Map<string, ReturnType<typeof createComposerAttachmentStore>>>();
export function scopedComposerAttachmentStore(owner: object, scope: string) {
  let scopes = owners.get(owner);
  if (!scopes) { scopes = new Map(); owners.set(owner, scopes); }
  let store = scopes.get(scope);
  if (!store) { store = createComposerAttachmentStore(); scopes.set(scope, store); }
  return store;
}
