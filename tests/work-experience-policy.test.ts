import { describe, expect, test } from "vitest";
import {
  filterModelToolsForExperience,
  modelToolAllowedForExperience,
  workspaceToolExperienceBlocker,
} from "../apps/server/src/runtime/experience-policy";

describe("experience capability policy", () => {
  test("keeps Chat conversational, gives Work bounded task tools, and preserves Development", () => {
    const definitions = [
      "web_search",
      "connected_app_read",
      "work_environment",
      "openpond_browser_open",
      "sandbox_exec",
    ].map((name) => ({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      execute: async () => ({
        toolCallId: "call",
        name,
        ok: true,
        contentText: "ok",
      }),
    }));

    expect(
      filterModelToolsForExperience({ experience: "chat" }, definitions).map(
        (definition) => definition.name
      )
    ).toEqual(["web_search"]);
    expect(
      filterModelToolsForExperience({ experience: "work" }, definitions).map(
        (definition) => definition.name
      )
    ).toEqual([
      "web_search",
      "connected_app_read",
      "work_environment",
      "openpond_browser_open",
    ]);
    expect(
      filterModelToolsForExperience(
        { experience: "development" },
        definitions
      ).map((definition) => definition.name)
    ).toEqual([
      "web_search",
      "connected_app_read",
      "openpond_browser_open",
      "sandbox_exec",
    ]);
    expect(
      modelToolAllowedForExperience("work", "openpond_browser_click")
    ).toBe(true);
    expect(
      modelToolAllowedForExperience("work", "openpond_browser_snapshot")
    ).toBe(true);
    expect(modelToolAllowedForExperience("work", "openpond_browser_type")).toBe(
      true
    );
    expect(modelToolAllowedForExperience("chat", "openpond_browser_click")).toBe(
      false
    );
  });

  test("rejects workspace access in Chat and developer actions in Work", () => {
    expect(
      workspaceToolExperienceBlocker({
        session: { experience: "chat" },
        action: "sandbox_status",
      })
    ).toContain("Chat does not have workspace compute");
    expect(
      workspaceToolExperienceBlocker({
        session: { experience: "work" },
        action: "sandbox_git_status",
      })
    ).toContain("Development capability");
    expect(
      workspaceToolExperienceBlocker({
        session: { experience: "development" },
        action: "sandbox_git_status",
      })
    ).toBeNull();
  });

  test("confines raw Work workspace requests to the standard projectless layout", () => {
    const validCreate = {
      command: "mkdir -p inputs work outputs",
      visibility: "private",
      reuseDefaultRuntime: false,
      markDefaultRuntime: false,
      runtime: { runtimeProfileId: "openpond-work-v1" },
    };

    expect(
      workspaceToolExperienceBlocker({
        session: { experience: "work" },
        action: "sandbox_create",
        args: validCreate,
      })
    ).toBeNull();
    expect(
      workspaceToolExperienceBlocker({
        session: { experience: "work" },
        action: "sandbox_create",
        args: { ...validCreate, repo: "https://example.com/repo.git" },
      })
    ).toContain("projectless");
    expect(
      workspaceToolExperienceBlocker({
        session: { experience: "work" },
        action: "sandbox_read_file",
        args: { path: "../secret" },
      })
    ).toContain("Work paths must stay");
    expect(
      workspaceToolExperienceBlocker({
        session: { experience: "work" },
        action: "sandbox_write_file",
        args: { path: "inputs/overwrite.txt" },
      })
    ).toContain("/workspace/work");
    expect(
      workspaceToolExperienceBlocker({
        session: { experience: "work" },
        action: "sandbox_exec",
        args: { command: "env" },
      })
    ).toContain("/workspace/work");
    expect(
      workspaceToolExperienceBlocker({
        session: { experience: "work" },
        action: "sandbox_exec",
        args: { command: "cd work && python report.py" },
      })
    ).toBeNull();
  });
});
