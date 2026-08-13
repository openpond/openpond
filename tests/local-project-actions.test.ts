import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import {
  createOpenPondActionModelToolDefinitions,
  type ModelToolExecutionContext,
} from "../apps/server/src/openpond/model-tool-registry";
import {
  localProjectActionCatalog,
  runLocalProjectAction,
} from "../apps/server/src/project-actions/local-project-actions";

const temporaryDirectories: string[] = [];
const actionsSource = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../packages/actions/src/index.ts",
);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ));
});

describe("local Project Actions in desktop Work", () => {
  test("discovers the selected Project and routes the scoped action through the local runner", async () => {
    const projectRoot = await proofProject();
    const catalog = await localProjectActionCatalog({
      id: "local_project_analytics",
      workspacePath: projectRoot,
    });
    const executionPayloads: unknown[] = [];
    const definitions = createOpenPondActionModelToolDefinitions({
      actionCatalog: catalog,
      executeWorkspaceTool: async () => {
        throw new Error("local Project Actions must not use sandbox action execution");
      },
      executeProjectAction: async (payload) => {
        executionPayloads.push(payload);
        const request = payload as {
          action: string;
          input: unknown;
          metadata: { projectRoot: string; toolCallId: string; turnId: string };
        };
        return runLocalProjectAction({
          projectRoot: request.metadata.projectRoot,
          actionId: request.action,
          value: request.input,
          runId: request.metadata.toolCallId,
          idempotencyKey: `${request.metadata.turnId}:${request.metadata.toolCallId}`,
        });
      },
    });
    const run = definitions.find((definition) => definition.name === "openpond_action_run");
    if (!run) throw new Error("openpond_action_run missing");
    const result = await run.execute(actionContext({
      actionId: "analytics.get_summary",
      input: { businessId: "relocation" },
    }));

    expect(catalog).toEqual([
      expect.objectContaining({
        id: "analytics.get_summary",
        sourcePath: projectRoot,
        implementation: expect.objectContaining({
          type: "openpond-project-action",
          projectId: "local_project_analytics",
          projectRoot,
        }),
      }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.contentText).toContain('"total": 42');
    expect(executionPayloads).toEqual([
      expect.objectContaining({
        action: "analytics.get_summary",
        input: { businessId: "relocation" },
        metadata: expect.objectContaining({
          source: "openpond_project_action",
          projectId: "local_project_analytics",
          projectRoot,
          turnId: "turn_1",
          toolCallId: "call_1",
        }),
      }),
    ]);
  });

  test("returns an empty catalog for a Project without an actions directory", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-no-actions-"));
    temporaryDirectories.push(projectRoot);
    await expect(localProjectActionCatalog({ id: "empty", workspacePath: projectRoot })).resolves.toEqual([]);
  });
});

function actionContext(args: Record<string, unknown>): ModelToolExecutionContext {
  return {
    session: {
      id: "session_1",
      provider: "openpond",
      title: "Analytics",
      appId: null,
      appName: null,
      workspaceKind: "local_project",
      workspaceId: "local_project_analytics",
      workspaceName: "Analytics",
      localProjectId: "local_project_analytics",
      cloudProjectId: null,
      cloudTeamId: null,
      cwd: null,
      codexThreadId: null,
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
      status: "running",
      pinned: false,
      archived: false,
      order: 0,
    },
    turnId: "turn_1",
    turnPermissions: {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      codexPermissionMode: "default",
      codexReasoningEffort: "medium",
    },
    provider: "openpond",
    model: "openpond-model",
    callId: "call_1",
    args,
    signal: new AbortController().signal,
    workspaceDiffBaseline: null,
    mentionedApps: [],
    userPrompt: "Show relocation analytics",
    turnMetadata: null,
  };
}

async function proofProject(): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-desktop-actions-"));
  temporaryDirectories.push(projectRoot);
  await fs.mkdir(path.join(projectRoot, "openpond", "actions"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "packages", "domain"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "packages", "domain", "analytics.ts"), [
    "export function getAnalytics(businessId: string) {",
    "  return { total: businessId === 'relocation' ? 42 : 0 };",
    "}",
    "",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "openpond", "actions", "analytics.ts"), [
    `import { defineAction } from ${JSON.stringify(actionsSource)};`,
    "import { z } from 'zod';",
    "import { getAnalytics } from '../../packages/domain/analytics.ts';",
    "export const getSummary = defineAction('analytics.get_summary', {",
    "  description: 'Return relocation analytics for one business.',",
    "  input: z.object({ businessId: z.string() }),",
    "  output: z.object({ total: z.number() }),",
    "  run(_context, input) { return getAnalytics(input.businessId); },",
    "});",
    "",
  ].join("\n"), "utf8");
  return projectRoot;
}
