import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TeamChatThread } from "@openpond/contracts";

import {
  NotificationsSettingsSection,
  teamChatSettingsThreadLabel,
} from "../apps/web/src/components/settings/NotificationsSettingsSection";
import { SidebarTeamSection } from "../apps/web/src/components/sidebar/SidebarTeamSection";

describe("notification settings", () => {
  test("renders global choices and conversation mute overrides in Settings", () => {
    const general = thread({ id: "general", kind: "general", title: "general" });
    const direct = thread({
      id: "direct",
      kind: "dm",
      title: null,
      mutedAt: "2026-07-14T12:00:00.000Z",
      participants: [participant("user_1", "Glu"), participant("user_2", "Adam")],
    });
    const markup = renderToStaticMarkup(
      createElement(NotificationsSettingsSection, {
        currentUserId: "user_1",
        enabled: true,
        mode: "direct_mentions",
        threads: [general, direct],
        onModeChange: () => undefined,
        onThreadMuteChange: async () => true,
      }),
    );

    expect(markup).toContain("Notifications");
    expect(markup).toContain('aria-label="Notify me about"');
    expect(markup).toContain("Direct messages and mentions");
    expect(markup).toContain("Conversation overrides");
    expect(markup).toContain("#general");
    expect(markup).toContain("Adam");
    expect(markup).toContain("1 muted");
    expect(markup).toContain("Unmute");
    expect(markup).toContain("Mute");
    expect(markup).not.toContain("NOTIFY ME ABOUT");
  });

  test("keeps the notification settings control out of the Team sidebar", () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarTeamSection, {
        currentUserId: "user_1",
        enabled: true,
        loading: false,
        members: [],
        openTeamDm: () => undefined,
        organization: null,
        selectedTeamThreadId: "general",
        selectTeamThread: () => undefined,
        threads: [thread({ id: "general", kind: "general", title: "general" })],
        view: "team",
      }),
    );

    expect(markup).toContain("general");
    expect(markup).toContain("Your Team");
    expect(markup).toContain('aria-label="Collapse Your Team"');
    expect(markup).toContain('aria-controls="team-sidebar-conversations"');
    expect(markup).toContain('aria-label="Collapse Team"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).not.toContain("Team notification settings");
    expect(markup).not.toContain("team-notification-menu");
  });

  test("uses readable labels for direct messages and groups", () => {
    const direct = thread({
      kind: "dm",
      participants: [participant("user_1", "Glu"), participant("user_2", "Adam")],
    });
    const group = thread({
      kind: "group",
      title: null,
      participants: [
        participant("user_1", "Glu"),
        participant("user_2", "Adam"),
        participant("user_3", "Sam"),
      ],
    });

    expect(teamChatSettingsThreadLabel(direct, "user_1")).toBe("Adam");
    expect(teamChatSettingsThreadLabel(group, "user_1")).toBe("Adam, Sam");
  });
});

function participant(userId: string, name: string) {
  return {
    userId,
    role: "member" as const,
    name,
    handle: null,
    image: null,
    lastReadSequence: 0,
  };
}

function thread(
  overrides: Partial<TeamChatThread> & Pick<TeamChatThread, "kind">,
): TeamChatThread {
  return {
    id: "thread_1",
    teamId: "team_1",
    kind: overrides.kind,
    title: "Conversation",
    createdByUserId: "user_1",
    lastMessageId: null,
    lastMessageSequence: 0,
    lastMessageAt: "2026-07-14T12:00:00.000Z",
    createdAt: "2026-07-14T12:00:00.000Z",
    updatedAt: "2026-07-14T12:00:00.000Z",
    unreadCount: 0,
    pinnedAt: null,
    mutedAt: null,
    archivedAt: null,
    participants: [],
    lastMessage: null,
    ...overrides,
  };
}
