import { describe, expect, it, vi } from "vitest";

import type { ClientConnection, ProfileWorkflowDiscovery } from "../../api";
import { launchProfileWorkflow } from "./launch-profile-workflow";

const catalog: ProfileWorkflowDiscovery = {
  profileRef: { source: "local", repositoryId: "profile-repo", profileId: "personal" },
  sourceRevision: "a".repeat(40),
  harnessRelease: { id: "release-1", contentHash: "b".repeat(64) },
  workflows: [{
    workflow: {
      id: "weekly_report",
      label: "Weekly report",
      description: "Summarize the week.",
      inputSchema: {
        type: "object",
        properties: { week: { type: "integer" } },
        required: ["week"],
        additionalProperties: false,
      },
      invocation: { kind: "instructions", instructions: "Write the report." },
      skillPaths: [],
    },
    binding: {
      schemaVersion: "openpond.profileWorkflowBinding.v1",
      profileId: "personal",
      sourceRevision: "a".repeat(40),
      harnessRelease: { id: "release-1", contentHash: "b".repeat(64) },
      catalogHash: "c".repeat(64),
      workflowId: "weekly_report",
    },
  }],
};

describe("Desktop Profile workflow launch", () => {
  it("creates a session on the discovered release and forwards input for server validation", async () => {
    const createSession = vi.fn().mockResolvedValue({ id: "session-1" });
    const sendTurn = vi.fn().mockResolvedValue({});
    const connection = {} as ClientConnection;
    const sessionId = await launchProfileWorkflow({
      connection,
      catalog,
      workflowId: "weekly_report",
      value: { week: 7 },
      client: { createSession, sendTurn },
    });
    expect(sessionId).toBe("session-1");
    expect(createSession).toHaveBeenCalledWith(connection, expect.objectContaining({
      currentProfile: catalog.profileRef,
      profileWorkflowBinding: catalog.workflows[0]?.binding,
    }));
    expect(sendTurn).toHaveBeenCalledWith(connection, "session-1", expect.objectContaining({
      prompt: "Weekly report",
      workflowInput: { week: 7 },
    }));
  });

  it("surfaces app-server input rejection", async () => {
    const createSession = vi.fn();
    createSession.mockResolvedValue({ id: "session-1" });
    const sendTurn = vi.fn().mockRejectedValue(new Error("Workflow input does not match its schema."));
    await expect(launchProfileWorkflow({
      connection: {} as ClientConnection,
      catalog,
      workflowId: "weekly_report",
      value: { week: "seven" },
      client: { createSession, sendTurn },
    })).rejects.toThrow();
    expect(createSession).toHaveBeenCalledOnce();
    expect(sendTurn).toHaveBeenCalledOnce();
  });
});
