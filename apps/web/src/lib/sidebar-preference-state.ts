import type { SidebarAppPreference, SidebarAppPreferences, SidebarSectionsCollapsed } from "@openpond/contracts";

export const RECENT_LOCAL_SIDEBAR_APP_PREFERENCE_TTL_MS = 60_000;
export const RECENT_LOCAL_SIDEBAR_SECTION_PREFERENCE_TTL_MS = 60_000;
export const RECENT_LOCAL_LAYOUT_WIDTH_PREFERENCE_TTL_MS = 60_000;

export type SidebarAppPreferenceChangeTimes = Record<string, number>;
type SidebarSectionKey = keyof SidebarSectionsCollapsed;
export type SidebarSectionPreferenceChangeTimes = Partial<Record<SidebarSectionKey, number>>;
export type LayoutWidthPreferenceChange = {
  value: number;
  changedAt: number;
};

const SIDEBAR_SECTION_KEYS: SidebarSectionKey[] = [
  "pinned",
  "projects",
  "cloudProjects",
  "chats",
  "savedForLater",
];

export function recordSidebarAppPreferenceChanges(
  changeTimes: SidebarAppPreferenceChangeTimes,
  previous: SidebarAppPreferences,
  next: SidebarAppPreferences,
  changedAt = Date.now(),
): void {
  for (const appId of preferenceIds(previous, next)) {
    if (!sameSidebarAppPreference(previous[appId], next[appId])) {
      changeTimes[appId] = changedAt;
    }
  }
}

export function mergeSidebarAppPreferencesPreservingRecentLocal(
  current: SidebarAppPreferences,
  incoming: SidebarAppPreferences,
  changeTimes: SidebarAppPreferenceChangeTimes,
  now = Date.now(),
): SidebarAppPreferences {
  const merged: SidebarAppPreferences = { ...incoming };
  for (const [appId, changedAt] of Object.entries(changeTimes)) {
    if (now - changedAt > RECENT_LOCAL_SIDEBAR_APP_PREFERENCE_TTL_MS) {
      delete changeTimes[appId];
      continue;
    }
    const currentHasPreference = hasOwn(current, appId);
    const currentPreference = current[appId];
    if (!currentHasPreference || sameSidebarAppPreference(currentPreference, incoming[appId])) continue;
    merged[appId] = currentPreference;
  }
  return merged;
}

export function recordSidebarSectionPreferenceChanges(
  changeTimes: SidebarSectionPreferenceChangeTimes,
  previous: SidebarSectionsCollapsed,
  next: SidebarSectionsCollapsed,
  changedAt = Date.now(),
): void {
  for (const key of SIDEBAR_SECTION_KEYS) {
    if (previous[key] !== next[key]) changeTimes[key] = changedAt;
  }
}

export function mergeSidebarSectionsCollapsedPreservingRecentLocal(
  current: SidebarSectionsCollapsed,
  incoming: SidebarSectionsCollapsed,
  changeTimes: SidebarSectionPreferenceChangeTimes,
  now = Date.now(),
): SidebarSectionsCollapsed {
  const merged: SidebarSectionsCollapsed = { ...incoming };
  for (const key of SIDEBAR_SECTION_KEYS) {
    const changedAt = changeTimes[key];
    if (changedAt === undefined) continue;
    if (now - changedAt > RECENT_LOCAL_SIDEBAR_SECTION_PREFERENCE_TTL_MS) {
      delete changeTimes[key];
      continue;
    }
    if (current[key] === incoming[key]) {
      delete changeTimes[key];
      continue;
    }
    merged[key] = current[key];
  }
  return sameSidebarSectionsCollapsed(current, merged) ? current : merged;
}

export function recordLayoutWidthPreferenceChange(
  previous: number,
  next: number,
  changedAt = Date.now(),
): LayoutWidthPreferenceChange | null {
  return previous === next ? null : { value: next, changedAt };
}

export function mergeLayoutWidthPreferencePreservingRecentLocal(
  incoming: number,
  localChange: LayoutWidthPreferenceChange | null,
  now = Date.now(),
): { value: number; localChange: LayoutWidthPreferenceChange | null } {
  if (!localChange) return { value: incoming, localChange: null };
  if (now - localChange.changedAt > RECENT_LOCAL_LAYOUT_WIDTH_PREFERENCE_TTL_MS) {
    return { value: incoming, localChange: null };
  }
  if (incoming === localChange.value) return { value: incoming, localChange };
  return { value: localChange.value, localChange };
}

function preferenceIds(previous: SidebarAppPreferences, next: SidebarAppPreferences): Set<string> {
  return new Set([...Object.keys(previous), ...Object.keys(next)]);
}

function sameSidebarAppPreference(
  left: SidebarAppPreference | undefined,
  right: SidebarAppPreference | undefined,
): boolean {
  return (
    left?.pinned === right?.pinned &&
    left?.archived === right?.archived &&
    left?.order === right?.order
  );
}

function sameSidebarSectionsCollapsed(
  left: SidebarSectionsCollapsed,
  right: SidebarSectionsCollapsed,
): boolean {
  return SIDEBAR_SECTION_KEYS.every((key) => left[key] === right[key]);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
