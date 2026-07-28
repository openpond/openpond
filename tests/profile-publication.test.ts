import { describe, expect, test } from "vitest";
import {
  profilePublicationContentsLookSensitive,
  profilePublicationPathEscapesRepo,
  profilePublicationPathIsSensitive,
  profilePublicationRelativePath,
  profilePublicationSelectionsWithoutTrackedSource,
} from "../apps/server/src/profile-publication";

describe("Profile publication safety", () => {
  test("excludes credential and runtime paths", () => {
    expect(profilePublicationPathIsSensitive("profiles/default/.env")).toBe(true);
    expect(profilePublicationPathIsSensitive("profiles/default/keys/deploy.pem")).toBe(true);
    expect(profilePublicationPathIsSensitive("profiles/default/.openpond/catalog.json")).toBe(true);
    expect(profilePublicationPathIsSensitive("profiles/default/skills/review/SKILL.md")).toBe(false);
  });

  test("blocks common embedded secret patterns without rejecting ordinary source", () => {
    expect(profilePublicationContentsLookSensitive(Buffer.from("api_key = 'secret-value-that-is-long'"))).toBe(true);
    expect(profilePublicationContentsLookSensitive(Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----"))).toBe(true);
    expect(profilePublicationContentsLookSensitive(Buffer.from("export function review() { return 'ok'; }"))).toBe(false);
  });

  test("reports selected items whose source is not tracked", () => {
    expect(profilePublicationSelectionsWithoutTrackedSource(
      ["profiles/default/agent/agent.ts", "profiles/default/skills/review/SKILL.md"],
      [
        { kind: "Agent", label: "default", prefix: "profiles/default/agent/" },
        { kind: "Skill", label: "review", prefix: "profiles/default/skills/review/" },
        { kind: "Skill", label: "decode", prefix: "profiles/default/skills/decode/" },
      ],
    )).toEqual([
      { kind: "Skill", label: "decode", prefix: "profiles/default/skills/decode/" },
    ]);
  });

  test("rejects source paths that escape the repository", () => {
    expect(profilePublicationPathEscapesRepo("/profiles/repo", "profiles/default/SKILL.md")).toBe(false);
    expect(profilePublicationPathEscapesRepo("/profiles/repo", "../credentials.txt")).toBe(true);
    expect(profilePublicationPathEscapesRepo("/profiles/repo", "/tmp/credentials.txt")).toBe(true);
  });

  test("supports Profiles whose source root is the repository root", () => {
    expect(profilePublicationRelativePath("", "settings/profile.yaml")).toBe("settings/profile.yaml");
    expect(profilePublicationRelativePath(".", "skills/review")).toBe("skills/review");
    expect(profilePublicationRelativePath("profiles/default", "skills/review")).toBe(
      "profiles/default/skills/review",
    );
  });
});
