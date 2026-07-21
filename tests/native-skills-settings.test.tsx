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
  test("lists only the hardcoded OpenPond skill catalog", () => {
    const markup = renderToStaticMarkup(
      createElement(SkillsSettingsSection, {
        onOpenNativeSkill: () => undefined,
      }),
    );

    expect(markup).toContain("Native skills");
    expect(markup).not.toContain(`${CONNECTED_APP_INTEGRATION_SKILLS.length} built in`);
    for (const skill of CONNECTED_APP_INTEGRATION_SKILLS) {
      expect(markup).toContain(skill.name);
      expect(markup).toContain(skill.path);
    }
    expect(markup).not.toContain("Profile skills");
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
