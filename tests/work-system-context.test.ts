import { describe, expect, test } from "vitest";
import type { Session } from "@openpond/contracts";
import { createHostedTurnHelpers } from "../apps/server/src/openpond/hosted-turn-helpers";

describe("Work system context", () => {
  test("describes lazy compute, reference handling, and read-only host browsing", async () => {
    const helpers = createHostedTurnHelpers({
      appendRuntimeEvent: async () => undefined,
    });
    const prompt = await helpers.hostedSystemPrompt(
      "Base",
      "",
      workSession(),
      { browserControlAvailable: true }
    );

    expect(prompt).toContain("Work compute is lazy");
    expect(prompt).toContain("Use work_capabilities");
    expect(prompt).toContain("authoritative references");
    expect(prompt).toContain("explicit user intent and provider readback");
    expect(prompt).toContain("read-only inspection");
    expect(prompt).toContain(
      "Browser clicks, typing, key presses, account changes, and publication are not available"
    );
  });
});

function workSession(): Session {
  return {
    id: "session_work",
    experience: "work",
    provider: "openrouter",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    openPondCommandAccessMode: "ask",
    title: "Work task",
    appId: null,
    appName: null,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    status: "idle",
    pinned: false,
    savedForLater: false,
    archived: false,
    order: 0,
  };
}
