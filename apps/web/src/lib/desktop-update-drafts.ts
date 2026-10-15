import { TaskResourceContextsSchema } from "@openpond/contracts";
import type { StoredComposerDraft } from "./composer-draft-store";
const KEY = "openpond.desktop-update-drafts.v1";
const MAX_SNAPSHOT_CHARACTERS = 512 * 1024;

// Renderer reloads and explicit update restarts share this recovery snapshot.
// Storage stays local to the Electron profile; no draft is sent over updater IPC.
export function saveDesktopUpdateDrafts(drafts: Record<string, StoredComposerDraft>, storage: Storage = window.localStorage): void {
  if (Object.keys(drafts).length > 512) throw new Error("Too many unsent drafts for local recovery.");
  const serialized = JSON.stringify(drafts);
  if (serialized.length > MAX_SNAPSHOT_CHARACTERS) throw new Error("Unsent drafts exceed local recovery capacity.");
  storage.setItem(KEY, serialized);
}

export function restoreDesktopUpdateDrafts(storage?: Storage): Record<string, StoredComposerDraft> {
  try {
    const target = storage ?? window.localStorage;
    const raw = target.getItem(KEY);
    if (!raw || raw.length > MAX_SNAPSHOT_CHARACTERS) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    if (Object.keys(parsed).length > 512) return {};
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
