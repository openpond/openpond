import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { Experience, Session } from "@openpond/contracts";
import {
  normalizeSessionPayload,
  storedSessionExperience,
} from "../apps/server/src/store/store-persistence";
import {
  SidebarExperienceMenu,
} from "../apps/web/src/components/sidebar/SidebarExperienceMenu";
import { NewExperienceSwitcher } from "../apps/web/src/components/app-shell/NewExperienceSwitcher";
import {
  EXPERIENCE_OPTIONS,
  newExperienceTitle,
} from "../apps/web/src/lib/experience-options";
import {
  WORK_STARTER_PROMPTS,
  WorkStarterPrompts,
} from "../apps/web/src/components/app-shell/WorkStarterPrompts";
import { sidebarSessionsForExperience } from "../apps/web/src/lib/experience-sessions";

describe("Work experience navigation", () => {
  test("classifies only projectless pre-experience general chats as Chat", () => {
    const projectless = session({ experience: undefined });
    const projectBacked = session({
      experience: undefined,
      workspaceKind: "local_project",
      workspaceId: "project_1",
      localProjectId: "project_1",
    });
    const codex = session({
      experience: undefined,
      provider: "codex",
      codexThreadId: "thread_1",
    });

    expect(storedSessionExperience(projectless)).toBe("chat");
    expect(normalizeSessionPayload(projectless).experience).toBe("chat");
    expect(storedSessionExperience(projectBacked)).toBe("development");
    expect(storedSessionExperience(codex)).toBe("development");
    expect(
      storedSessionExperience(
        session({ experience: "development", workspaceKind: undefined })
      )
    ).toBe("development");
  });

  test("shares projectless Chat and Work recents while separating Development", () => {
    const chat = session({ id: "chat", experience: "chat" });
    const work = session({ id: "work", experience: "work" });
    const development = session({
      id: "development",
      experience: "development",
      workspaceKind: "local_project",
      workspaceId: "project_1",
      localProjectId: "project_1",
    });
    const sessions = [chat, work, development];

    expect(
      sidebarSessionsForExperience(sessions, "chat").map((item) => item.id)
    ).toEqual(["chat", "work"]);
    expect(
      sidebarSessionsForExperience(sessions, "work").map((item) => item.id)
    ).toEqual(["chat", "work"]);
    expect(
      sidebarSessionsForExperience(sessions, "development").map(
        (item) => item.id
      )
    ).toEqual(["development"]);
  });

  test("renders the wordmark trigger and truthful Work starter examples", () => {
    const menu = renderToStaticMarkup(
      createElement(SidebarExperienceMenu, {
        value: "work",
        onChange: () => undefined,
      })
    );
    const starters = renderToStaticMarkup(
      createElement(WorkStarterPrompts, {
        onSelect: () => undefined,
      })
    );

    const switcher = renderToStaticMarkup(
      createElement(NewExperienceSwitcher, {
        value: "development",
        onChange: () => undefined,
      })
    );

    expect(EXPERIENCE_OPTIONS.map((option) => option.label)).toEqual([
      "Chat",
      "Work",
      "Developer",
    ]);
    expect(newExperienceTitle("chat")).toBe("New chat");
    expect(newExperienceTitle("work")).toBe("New task");
    expect(newExperienceTitle("development")).toBe("New task");
    expect(menu).toContain("sidebar-experience-trigger");
    expect(menu).toContain(
      '<span class="sidebar-experience-label">Work</span>'
    );
    expect(menu).toContain("OpenPond experience: Work");
    expect(menu).toContain('aria-haspopup="menu"');
    expect(switcher).toContain('role="radiogroup"');
    expect(switcher).toContain('aria-label="Choose experience"');
    expect(switcher).toContain('data-experience="development"');
    expect(switcher).toContain('aria-checked="true"');
    expect(WORK_STARTER_PROMPTS).toHaveLength(4);
    for (const starter of WORK_STARTER_PROMPTS) {
      expect(starters).toContain(starter.label);
      expect(starter.prompt.length).toBeGreaterThan(40);
    }
  });
});

function session(
  overrides: Partial<Omit<Session, "experience">> & {
    experience?: Experience;
  } = {}
): Session {
  return {
    id: "session_1",
    experience: "chat",
    provider: "openpond",
    modelRef: null,
    openPondCommandAccessMode: "ask",
    title: "Test session",
    appId: null,
    appName: null,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    status: "idle",
    pinned: false,
    savedForLater: false,
    archived: false,
    order: 0,
    ...overrides,
  } as Session;
}
