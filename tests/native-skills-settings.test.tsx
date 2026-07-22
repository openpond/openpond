import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  CONNECTED_APP_INTEGRATION_SKILLS,
  connectedAppIntegrationSkillByProvider,
  type OpenPondExtension,
} from "@openpond/contracts";

import { NativeSkillSidebar } from "../apps/web/src/components/app-shell/NativeSkillSidebar";
import { SkillsSettingsSection } from "../apps/web/src/components/settings/SkillsSettingsSection";
import { extensionSourceSelection } from "../apps/web/src/components/settings/extension-source-selection";

describe("native skills settings", () => {
  test("separates personal Codex skills from bundled app integration skills", () => {
    const extension = {
      id: "github:duckailabs/ducky-capital-skills",
      source: "github",
      owner: "duckailabs",
      repo: "ducky-capital-skills",
      repositoryUrl: "https://github.com/duckailabs/ducky-capital-skills",
      requestedRef: "HEAD",
      resolvedCommit: "2d79599b6706bd321b40c6f90b176be1e32a8091",
      sourcePath: "/home/user/.openpond/extensions/github/duckailabs/ducky-capital-skills/current",
      readmePath: "/home/user/.openpond/extensions/github/duckailabs/ducky-capital-skills/current/README.md",
      installedAt: "2026-07-22T12:00:00.000Z",
      updatedAt: "2026-07-22T12:00:00.000Z",
      packageHash: "package-hash",
      validationStatus: "valid",
      validationMessages: [],
      skills: [{
        name: "review-ethereum-transaction",
        description: "Review an Ethereum transaction.",
        relativePath: "skills/review-ethereum-transaction/SKILL.md",
        sourcePath: "/home/user/.openpond/extensions/github/duckailabs/ducky-capital-skills/current/skills/review-ethereum-transaction/SKILL.md",
        charCount: 500,
        sourceHash: "skill-hash",
        resourceFiles: ["references/example.md"],
        validationStatus: "valid",
        validationMessages: [],
      }],
    } satisfies OpenPondExtension;
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
        extensionCatalog: {
          rootPath: "/home/user/.openpond/extensions",
          registryPath: "/home/user/.openpond/extensions/registry.json",
          error: null,
          extensions: [extension],
        },
        connection: null,
        onExtensionCatalog: () => undefined,
        onError: () => undefined,
        onOpenSkill: () => undefined,
        onOpenExtension: () => undefined,
      }),
    );

    expect(markup).toContain("Personal Codex skills");
    expect(markup).toContain("Third-party extensions");
    expect(markup).toContain("Add a GitHub skill pack");
    expect(markup).toContain("Open duckailabs/ducky-capital-skills extension source");
    expect(markup).toContain("make-openpond-video");
    expect(markup).toContain("1 packaged resource");
    expect(markup).toContain("App integration skills");
    expect(markup).not.toContain(`${CONNECTED_APP_INTEGRATION_SKILLS.length} built in`);
    for (const skill of CONNECTED_APP_INTEGRATION_SKILLS) {
      expect(markup).toContain(skill.name);
      expect(markup).toContain(skill.path);
    }
    expect(markup).not.toContain("Create");
    expect(extensionSourceSelection(extension)).toMatchObject({
      name: "duckailabs/ducky-capital-skills",
      scope: "extension",
      files: [
        "README.md",
        "skills/review-ethereum-transaction/SKILL.md",
        "skills/review-ethereum-transaction/references/example.md",
      ],
    });
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

    expect(markup).toContain("Skill source: google-connected-app");
    expect(markup).toContain("integration_skills/google.md");
    expect(markup).toContain("# Google Connected App");
    expect(markup).toContain("Use Google only through server-provided connected app tools.");
  });
});
