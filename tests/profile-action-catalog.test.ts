import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createOpenPondActionModelToolDefinitions,
} from "../apps/server/src/openpond/model-tool-registry";
import {
  buildOpenPondProfileActionCatalog,
} from "../apps/web/src/lib/openpond-action-run";
import { loadProfileActionCatalogForSources } from "../packages/cloud/src/profile/profile-catalog";

describe("Profile Agent action catalog", () => {
  test("resolves named SDK input schemas for native model tools", async () => {
    const sourcePath = await mkdtemp(
      path.join(os.tmpdir(), "openpond-profile-action-catalog-"),
    );
    try {
      await mkdir(path.join(sourcePath, ".openpond"), { recursive: true });
      await writeFile(
        path.join(sourcePath, ".openpond/agent-manifest.json"),
        JSON.stringify({
          inputSchemas: {
            BudgetDecisionInput: {
              type: "object",
              additionalProperties: false,
              required: ["scenarioId"],
              properties: {
                scenarioId: { type: "string" },
              },
            },
          },
          actionCatalog: [
            {
              id: "submit-budget-decision",
              name: "submit-budget-decision",
              inputSchema: "BudgetDecisionInput",
              visibility: "end_user",
            },
          ],
        }),
      );
      await writeFile(
        path.join(sourcePath, ".openpond/action-registry.json"),
        JSON.stringify({
          actions: [
            {
              id: "submit-budget-decision",
              name: "submit-budget-decision",
              inputSchema: "BudgetDecisionInput",
              visibility: "end_user",
            },
          ],
        }),
      );

      const loaded = await loadProfileActionCatalogForSources([
        {
          agentId: "marketing-portfolio-manager",
          sourcePath,
          preferred: true,
        },
      ]);

      expect(loaded.catalog).toMatchObject({
        actionCount: 1,
        stale: false,
        error: null,
      });
      expect(loaded.actionCatalog[0]).toMatchObject({
        id: "submit-budget-decision",
        agentId: "marketing-portfolio-manager",
        sourceActionId: "submit-budget-decision",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["scenarioId"],
          properties: {
            scenarioId: { type: "string" },
          },
        },
      });

      const profileActions = buildOpenPondProfileActionCatalog({
        actionCatalog: loaded.actionCatalog,
        agents: [
          {
            id: "marketing-portfolio-manager",
            name: "Marketing Portfolio Manager",
            path: "agents/marketing-portfolio-manager",
            enabled: true,
          },
        ],
      });
      const tools = createOpenPondActionModelToolDefinitions({
        actionCatalog: profileActions,
        executeWorkspaceTool: async () => {
          throw new Error("Profile Agent tools do not use workspace actions.");
        },
        executeProfileAction: async () => ({ ok: true }),
      });
      expect(
        tools.find((tool) =>
          tool.name.startsWith("agent_submit_budget_decision_"),
        ),
      ).toMatchObject({
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["scenarioId"],
          properties: {
            scenarioId: { type: "string" },
          },
        },
      });
    } finally {
      await rm(sourcePath, { recursive: true, force: true });
    }
  });
});
