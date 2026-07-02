import { describe, expect, test } from "bun:test";
import type { RuntimeEvent, Session } from "@openpond/contracts";

import { createHostedTurnHelpers } from "../apps/server/src/openpond/hosted-turn-helpers";

const session: Session = {
  id: "session_1",
  provider: "openpond",
  title: "OpenPond Project Chat",
  appId: null,
  appName: null,
  workspaceKind: "sandbox",
  workspaceId: "project_1",
  workspaceName: "Water Project",
  cwd: null,
  codexThreadId: null,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  status: "idle",
  pinned: false,
  archived: false,
  order: 0,
};

describe("OpenPond action catalog context", () => {
  test("adds schema-backed project actions to ordinary hosted chat turns", async () => {
    const helpers = createHostedTurnHelpers({
      appendRuntimeEvent: async (_event: RuntimeEvent) => {},
    });

    const prompt = await helpers.hostedSystemPrompt(
      "Base hosted prompt.",
      "",
      session,
      {
        openPondActionCatalog: [
          {
            id: "water.estimate",
            label: "Run Water Estimate",
            description: "Run the workflow directly.",
            inputSchema: {
              type: "object",
              properties: {
                parcelId: { type: "string" },
              },
              required: ["parcelId"],
            },
            outputSchema: {
              type: "object",
              properties: {
                status: { type: "string" },
              },
            },
            implementation: { type: "workflow", workflowId: "water-estimate" },
          },
        ],
      },
    );

    expect(prompt).toContain("OpenPond project action catalog:");
    expect(prompt).toContain("- Use sandbox_run_action only when an action is needed");
    expect(prompt).toContain("- Do not infer hidden action names from user text.");
    expect(prompt).toContain("water.estimate: Run Water Estimate - Run the workflow directly.");
    expect(prompt).toContain('inputSchema: {"type":"object","properties":{"parcelId":{"type":"string"}},"required":["parcelId"]}');
    expect(prompt).toContain('outputSchema: {"type":"object","properties":{"status":{"type":"string"}}}');
  });
});
