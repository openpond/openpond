import { describe, expect, test } from "vitest";
import {
  authoringCommandRoute,
  authoringCommandRouteFromLegacyAgentRun,
} from "../apps/server/src/runtime/authoring-command-routing";

describe("skill-backed authoring command routing", () => {
  test("maps Skill authoring slash commands to the bundled Skill package", () => {
    expect(authoringCommandRoute(
      "/skill create --name release-notes Draft release notes from merged changes.",
    )).toEqual({
      skillName: "openpond-skill-authoring",
      intent: {
        artifact: "skill",
        operation: "create",
        objective: "Draft release notes from merged changes.",
        targetSkillName: "release-notes",
        source: "slash_command",
      },
    });

    expect(authoringCommandRoute(
      "/skill edit release-notes Include verification evidence.",
    )).toEqual({
      skillName: "openpond-skill-authoring",
      intent: {
        artifact: "skill",
        operation: "edit",
        objective: "Include verification evidence.",
        targetSkillName: "release-notes",
        source: "slash_command",
      },
    });
  });

  test("maps Agent authoring slash commands to the bundled Agent package", () => {
    expect(authoringCommandRoute(
      "/agent create Review release changes and draft concise notes.",
    )).toEqual({
      skillName: "openpond-agent-authoring",
      intent: {
        artifact: "agent",
        operation: "create",
        objective: "Review release changes and draft concise notes.",
        targetAgentId: null,
        source: "slash_command",
      },
    });

    expect(authoringCommandRoute(
      "/agent improve release-reviewer Preserve citations in the final answer.",
    )).toEqual({
      skillName: "openpond-agent-authoring",
      intent: {
        artifact: "agent",
        operation: "improve",
        objective: "Preserve citations in the final answer.",
        targetAgentId: "release-reviewer",
        source: "slash_command",
      },
    });
  });

  test("leaves read-only and natural-language discovery in the normal catalog path", () => {
    expect(authoringCommandRoute("/skill list")).toBeNull();
    expect(authoringCommandRoute("/skill help")).toBeNull();
    expect(authoringCommandRoute("/agent help")).toBeNull();
    expect(authoringCommandRoute("make a skill for release notes")).toBeNull();
    expect(authoringCommandRoute("how should I design an agent?")).toBeNull();
  });

  test("fails closed when an edit or improvement lacks an exact target", () => {
    expect(() => authoringCommandRoute("/skill edit")).toThrow(
      "/skill edit requires an exact lowercase kebab-case Skill name.",
    );
    expect(() => authoringCommandRoute("/agent improve")).toThrow(
      "/agent improve requires an exact lowercase kebab-case Agent ID.",
    );
  });
});
