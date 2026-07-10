import { describe, expect, test } from "bun:test";
import type { OpenPondProfileSkill } from "@openpond/contracts";

import {
  activeProfileSkillInvocationContext,
  profileSkillInvocationMatchesForQuery,
  profileSkillInvocationText,
  replaceActiveProfileSkillInvocation,
} from "../apps/web/src/lib/profile-skill-invocations";

function profileSkill(overrides: Partial<OpenPondProfileSkill> = {}): OpenPondProfileSkill {
  const name = overrides.name ?? "docker-cleanup";
  return {
    name,
    description: "Clean up Docker disk usage safely",
    path: `skills/${name}/SKILL.md`,
    scope: "profile",
    enabled: true,
    sourcePath: "/home/glu/.openpond/profile",
    charCount: 128,
    sourceHash: "hash",
    validationStatus: "valid",
    validationMessages: [],
    ...overrides,
  };
}

describe("profile skill composer invocations", () => {
  test("detects an active dollar skill trigger at the cursor", () => {
    expect(activeProfileSkillInvocationContext("$", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(activeProfileSkillInvocationContext("please $dock", 12)).toEqual({ start: 7, end: 12, query: "dock" });
    expect(activeProfileSkillInvocationContext("cost is $5", 10)).toBeNull();
    expect(activeProfileSkillInvocationContext("email a$b", 9)).toBeNull();
  });

  test("matches enabled valid skills by name, description, or path", () => {
    const matches = profileSkillInvocationMatchesForQuery([
      profileSkill({ name: "docker-cleanup" }),
      profileSkill({ name: "release-notes", description: "Draft changelog summaries" }),
      profileSkill({ name: "invalid-skill", validationStatus: "error", enabled: false }),
    ], "");

    expect(matches.map((skill) => skill.name)).toEqual(["docker-cleanup", "release-notes"]);
    expect(profileSkillInvocationMatchesForQuery(matches, "change").map((skill) => skill.name)).toEqual(["release-notes"]);
  });

  test("lists the full enabled skill set by default", () => {
    const skills = Array.from({ length: 10 }, (_, index) =>
      profileSkill({ name: `skill-${String(index).padStart(2, "0")}` })
    );

    expect(profileSkillInvocationMatchesForQuery(skills, "")).toHaveLength(10);
    expect(profileSkillInvocationMatchesForQuery(skills, "", 3).map((skill) => skill.name)).toEqual([
      "skill-00",
      "skill-01",
      "skill-02",
    ]);
  });

  test("builds the literal prompt invocation", () => {
    expect(profileSkillInvocationText(profileSkill())).toBe("$docker-cleanup");
  });

  test("replaces the typed cashtag fragment with the full skill name", () => {
    expect(replaceActiveProfileSkillInvocation(
      "please $dock",
      { start: 7, end: 12, query: "dock" },
      profileSkill(),
    )).toEqual({
      cursor: 23,
      value: "please $docker-cleanup ",
    });
  });

  test("preserves surrounding prompt text without introducing duplicate spaces", () => {
    expect(replaceActiveProfileSkillInvocation(
      "please $dock later",
      { start: 7, end: 12, query: "dock" },
      profileSkill(),
    )).toEqual({
      cursor: 22,
      value: "please $docker-cleanup later",
    });
  });
});
