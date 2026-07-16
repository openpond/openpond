import { describe, expect, test } from "vitest";
import type { SidebarAppPreferences } from "@openpond/contracts";
import {
  mergeLayoutWidthPreferencePreservingRecentLocal,
  mergeSidebarAppPreferencesPreservingRecentLocal,
  mergeSidebarSectionsCollapsedPreservingRecentLocal,
  RECENT_LOCAL_LAYOUT_WIDTH_PREFERENCE_TTL_MS,
  RECENT_LOCAL_SIDEBAR_APP_PREFERENCE_TTL_MS,
  RECENT_LOCAL_SIDEBAR_SECTION_PREFERENCE_TTL_MS,
  recordLayoutWidthPreferenceChange,
  recordSidebarAppPreferenceChanges,
  recordSidebarSectionPreferenceChanges,
  type SidebarAppPreferenceChangeTimes,
  type SidebarSectionPreferenceChangeTimes,
} from "../apps/web/src/lib/sidebar-preference-state";

describe("sidebar app preference state merging", () => {
  test("keeps recent local project pins when stale bootstrap preferences arrive", () => {
    const changedAt = 1_000;
    const previous: SidebarAppPreferences = {
      "local:project_1": { pinned: false, archived: false, order: 4 },
    };
    const current: SidebarAppPreferences = {
      "local:project_1": { pinned: true, archived: false, order: 4 },
    };
    const incoming: SidebarAppPreferences = {
      "local:project_1": { pinned: false, archived: false, order: 4 },
    };
    const changeTimes: SidebarAppPreferenceChangeTimes = {};

    recordSidebarAppPreferenceChanges(changeTimes, previous, current, changedAt);

    expect(
      mergeSidebarAppPreferencesPreservingRecentLocal(current, incoming, changeTimes, changedAt + 50),
    ).toEqual(current);
  });

  test("accepts incoming preferences after the local freshness window expires", () => {
    const changedAt = 1_000;
    const current: SidebarAppPreferences = {
      "local:project_1": { pinned: true, archived: false, order: 4 },
    };
    const incoming: SidebarAppPreferences = {
      "local:project_1": { pinned: false, archived: false, order: 4 },
    };
    const changeTimes: SidebarAppPreferenceChangeTimes = {
      "local:project_1": changedAt,
    };

    expect(
      mergeSidebarAppPreferencesPreservingRecentLocal(
        current,
        incoming,
        changeTimes,
        changedAt + RECENT_LOCAL_SIDEBAR_APP_PREFERENCE_TTL_MS + 1,
      ),
    ).toEqual(incoming);
    expect(changeTimes).toEqual({});
  });

  test("does not stamp unchanged preferences", () => {
    const previous: SidebarAppPreferences = {
      "local:project_1": { pinned: true, archived: false, order: 4 },
    };
    const changeTimes: SidebarAppPreferenceChangeTimes = {};

    recordSidebarAppPreferenceChanges(changeTimes, previous, { ...previous }, 1_000);

    expect(changeTimes).toEqual({});
  });
});

describe("sidebar section collapsed state merging", () => {
  const expanded = {
    pinned: false,
    projects: false,
    cloudProjects: false,
    chats: false,
  };

  test("keeps recent local collapse changes when stale bootstrap preferences arrive", () => {
    const current = {
      ...expanded,
      projects: true,
    };
    const incoming = {
      ...expanded,
    };
    const changeTimes: SidebarSectionPreferenceChangeTimes = {};

    recordSidebarSectionPreferenceChanges(changeTimes, expanded, current, 1_000);

    expect(
      mergeSidebarSectionsCollapsedPreservingRecentLocal(current, incoming, changeTimes, 1_050),
    ).toBe(current);
  });

  test("accepts incoming section collapse preferences after the local freshness window expires", () => {
    const current = {
      ...expanded,
      projects: true,
    };
    const incoming = {
      ...expanded,
    };
    const changeTimes: SidebarSectionPreferenceChangeTimes = {
      projects: 1_000,
    };

    expect(
      mergeSidebarSectionsCollapsedPreservingRecentLocal(
        current,
        incoming,
        changeTimes,
        1_000 + RECENT_LOCAL_SIDEBAR_SECTION_PREFERENCE_TTL_MS + 1,
      ),
    ).toEqual(incoming);
    expect(changeTimes).toEqual({});
  });

  test("clears section change markers when incoming preferences catch up", () => {
    const current = {
      ...expanded,
      chats: true,
    };
    const changeTimes: SidebarSectionPreferenceChangeTimes = {
      chats: 1_000,
    };

    expect(
      mergeSidebarSectionsCollapsedPreservingRecentLocal(current, current, changeTimes, 1_050),
    ).toBe(current);
    expect(changeTimes).toEqual({});
  });
});

describe("layout width preference state merging", () => {
  test("keeps a recent local width when stale bootstrap preferences arrive", () => {
    const localChange = recordLayoutWidthPreferenceChange(332, 420, 1_000);

    expect(mergeLayoutWidthPreferencePreservingRecentLocal(332, localChange, 1_050)).toEqual({
      value: 420,
      localChange,
    });
  });

  test("keeps the local width marker after catch-up so late stale payloads cannot snap back", () => {
    const localChange = recordLayoutWidthPreferenceChange(332, 420, 1_000);

    const caughtUp = mergeLayoutWidthPreferencePreservingRecentLocal(420, localChange, 1_050);
    expect(caughtUp).toEqual({
      value: 420,
      localChange,
    });
    expect(mergeLayoutWidthPreferencePreservingRecentLocal(332, caughtUp.localChange, 1_100)).toEqual({
      value: 420,
      localChange,
    });
  });

  test("accepts incoming widths after the local freshness window expires", () => {
    const localChange = recordLayoutWidthPreferenceChange(332, 420, 1_000);

    expect(
      mergeLayoutWidthPreferencePreservingRecentLocal(
        332,
        localChange,
        1_000 + RECENT_LOCAL_LAYOUT_WIDTH_PREFERENCE_TTL_MS + 1,
      ),
    ).toEqual({
      value: 332,
      localChange: null,
    });
  });
});
