import { describe, expect, test } from "vitest";
import type { LocalProject } from "@openpond/contracts";

import { actionCatalogForLocalCrossSystemFixture } from "../apps/web/src/lib/local-cross-system-action-catalog";
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

  test("adds synthetic tools for the selected local Cross-System fixture", () => {
    const project = localProject({
      name: "cross-system-operations",
      workspacePath: "/work/cross-system-operations",
    });

    const catalog = actionCatalogForLocalCrossSystemFixture(project);
    expect(catalog.map((action) => action.id)).toEqual([
      "search_crm",
      "query_billing",
      "search_support",
      "run_python",
    ]);
    expect(catalog[0]).toEqual(expect.objectContaining({
      sourcePath: project.path,
      sourceActionId: "search_crm",
      implementation: { type: "tool", projectId: project.id },
      invokesModel: false,
    }));
    expect(catalog[0]?.inputSchema).toEqual(expect.objectContaining({ type: "object" }));
  });

  test("does not invent local tools for unrelated projects", () => {
    expect(actionCatalogForLocalCrossSystemFixture(localProject({ name: "other" }))).toEqual([]);
  });
});

function localProject(overrides: Partial<LocalProject> = {}): LocalProject {
  return {
    id: "local_cross_system",
    name: "Local project",
    path: "/work/project",
    workspacePath: "/work/project",
    repoPath: "/work/project",
    source: "folder",
    sandboxTemplate: null,
    linkedOpenPondApp: null,
    linkedSandboxProject: null,
    preferredSandboxAgentId: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}
