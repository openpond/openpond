const KEY = "openpond.desktop-update-drafts.v1";

// Only an explicit update restart saves this recovery snapshot. Storage remains
// local to the Electron profile; no draft content is sent over updater IPC.
export function saveDesktopUpdateDrafts(drafts: Record<string, string>, storage: Storage = window.localStorage): void {
  storage.setItem(KEY, JSON.stringify(drafts));
}

export function restoreDesktopUpdateDrafts(storage?: Storage): Record<string, string> {
  try {
    const target = storage ?? window.localStorage;
    const raw = target.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const drafts: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && /^(?:new-chat|(?:session|project|app):.+)$/.test(key)) drafts[key] = value;
    }
    return drafts;
  } catch {
    return {};
  }
}

export function clearDesktopUpdateDrafts(storage: Storage = window.localStorage): void {
  storage.removeItem(KEY);
}
