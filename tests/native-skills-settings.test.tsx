import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  CONNECTED_APP_INTEGRATION_SKILLS,
  connectedAppIntegrationSkillByProvider,
} from "@openpond/contracts";

import { NativeSkillSidebar } from "../apps/web/src/components/app-shell/NativeSkillSidebar";
import { SkillsSettingsSection } from "../apps/web/src/components/settings/SkillsSettingsSection";

describe("native skills settings", () => {
  test("separates personal Codex skills from bundled app integration skills", () => {
    const markup = renderToStaticMarkup(
      createElement(SkillsSettingsSection, {
        personalSkills: [{
          name: "make-openpond-video",
          description: "Render a branded product video.",
          path: "/home/user/.codex/skills/make-openpond-video/SKILL.md",
          sourcePath: "/home/user/.codex/skills/make-openpond-video",
          enabled: true,
          charCount: 800,
          sourceHash: "hash",
          validationStatus: "valid",
          validationMessages: [],
          resourceFiles: ["scripts/render.py"],
          updatedAt: "2026-07-22T12:00:00.000Z",
        }],
        onOpenNativeSkill: () => undefined,
      }),
    );

    expect(markup).toContain("Personal Codex skills");
    expect(markup).toContain("make-openpond-video");
    expect(markup).toContain("1 packaged resource");
    expect(markup).toContain("App integration skills");
    expect(markup).not.toContain(`${CONNECTED_APP_INTEGRATION_SKILLS.length} built in`);
    for (const skill of CONNECTED_APP_INTEGRATION_SKILLS) {
      expect(markup).toContain(skill.name);
      expect(markup).toContain(skill.path);
    }
    expect(markup).not.toContain("Create");
  });

  test("shows the exact bundled Markdown body in the right sidebar", () => {
    const skill = connectedAppIntegrationSkillByProvider("google");
    if (!skill) throw new Error("Google native skill missing");

    const markup = renderToStaticMarkup(
      createElement(NativeSkillSidebar, {
        expanded: false,
        skill,
        onClose: () => undefined,
        onResizeStart: () => undefined,
        onToggleExpanded: () => undefined,
      }),
    );

    expect(markup).toContain("Native skill source: google-connected-app");
    expect(markup).toContain("integration_skills/google.md");
    expect(markup).toContain("# Google Connected App");
    expect(markup).toContain("Use Google only through server-provided connected app tools.");
  });
});
