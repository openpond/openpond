import { TaskResourceContextsSchema } from "@openpond/contracts";
import type { StoredComposerDraft } from "./composer-draft-store";
const KEY = "openpond.desktop-update-drafts.v1";

// Only an explicit update restart saves this recovery snapshot. Storage remains
// local to the Electron profile; no draft content is sent over updater IPC.
export function saveDesktopUpdateDrafts(drafts: Record<string, StoredComposerDraft>, storage: Storage = window.localStorage): void {
  storage.setItem(KEY, JSON.stringify(drafts));
}

export function restoreDesktopUpdateDrafts(storage?: Storage): Record<string, StoredComposerDraft> {
  try {
    const target = storage ?? window.localStorage;
    const raw = target.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const drafts: Record<string, StoredComposerDraft> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!/^(?:new-chat|(?:session|project|app):.+)$/.test(key)) continue;
      if (typeof value === "string") drafts[key] = value;
      else if (value && typeof value === "object" && !Array.isArray(value)) {
        const entry = value as Record<string, unknown>;
        const contexts = TaskResourceContextsSchema.safeParse(entry.resourceContexts);
        if (typeof entry.prompt === "string" && contexts.success) drafts[key] = {prompt:entry.prompt,resourceContexts:contexts.data};
      }
    }
    return drafts;
  } catch {
    return {};
  }
}

export function clearDesktopUpdateDrafts(storage: Storage = window.localStorage): void {
  storage.removeItem(KEY);
}
