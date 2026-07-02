import { describe, expect, test } from "bun:test";

import { actionCatalogForProject } from "../apps/web/src/lib/sandbox-action-catalog";
import type { SandboxProject } from "../apps/web/src/lib/sandbox-types";

describe("sandbox action catalog", () => {
  test("prefers source action catalog ids over legacy action names", () => {
    const project = {
      sandboxManifest: {
        actionCatalog: [
          {
            id: "water.estimate",
            label: "Run Water Estimate",
            description: "Run the workflow directly.",
            implementation: { type: "workflow", workflowId: "water-estimate" },
            inputSchema: {
              type: "object",
              properties: { parcelId: { type: "string" } },
              required: ["parcelId"],
            },
            outputSchema: { type: "object", properties: { status: { type: "string" } } },
          },
        ],
        actions: [{ name: "chat" }],
      },
      sandboxActionRegistry: {
        actions: [
          {
            id: "water.estimate",
            name: "legacy-water-estimate",
            command: "openpond-agent run water.estimate",
          },
        ],
      },
    } as SandboxProject;

    expect(actionCatalogForProject(project)).toEqual([
      expect.objectContaining({
        id: "water.estimate",
        label: "Run Water Estimate",
        inputSchema: {
          type: "object",
          properties: { parcelId: { type: "string" } },
          required: ["parcelId"],
        },
        outputSchema: {
          type: "object",
          properties: { status: { type: "string" } },
        },
        implementation: { type: "workflow", workflowId: "water-estimate" },
      }),
      expect.objectContaining({
        id: "chat",
        label: "Chat",
      }),
    ]);
  });
});
