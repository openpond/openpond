import { describe, expect, test } from "vitest";
import {
  createConnectedAppSkillModelToolDefinitions,
  type ModelToolExecutionContext,
} from "../apps/server/src/openpond/model-tool-registry";
import {
  createConnectedAppProviderModelToolDefinitions,
  type ConnectedAppToolExecutionRequest,
} from "../apps/server/src/openpond/connected-app-tool-registry";
import type { ResolvedConnectedAppContext } from "../apps/server/src/openpond/connected-app-context";
import type { Session } from "../packages/contracts/src";

describe("connected app chat proof", () => {
  test("loads provider instructions before a scoped provider read", async () => {
    const connectedApp = googleConnectedAppContext();
    const skillDefinitions = createConnectedAppSkillModelToolDefinitions({
      connectedApps: [connectedApp],
    });
    const skillRead = skillDefinitions.find((definition) => definition.name === "connected_app_skill_read");
    if (!skillRead) throw new Error("connected_app_skill_read missing");

    const skillResult = await skillRead.execute(actionContext({ provider: "google" }));

    expect(skillResult.ok).toBe(true);
    expect(skillResult.contentText).toContain("Google Connected App");
    expect(skillResult.contentText).toContain("server-provided connected app tools");
    expect(skillResult.contentText).not.toContain("conn_google");
    expect(skillResult.contentText).not.toContain("refresh_token");

    const executorRequests: ConnectedAppToolExecutionRequest[] = [];
    const providerDefinitions = createConnectedAppProviderModelToolDefinitions({
      connectedApps: [connectedApp],
      executeConnectedAppTool: async (request) => {
        executorRequests.push(request);
        return {
          ok: true,
          output: "Read Google Doc Budget.",
          data: {
            ref: "google:doc:budget",
            title: "Budget",
            content: "Approved budget summary",
            connectionId: "conn_google",
            accessToken: "oauth provider-token",
            nested: { refreshToken: "provider-refresh-token" },
          },
        };
      },
    });
    const read = providerDefinitions.find((definition) => definition.name === "connected_app_read");
    if (!read) throw new Error("connected_app_read missing");

    const readResult = await read.execute(actionContext({
      provider: "google",
      ref: "google:doc:budget",
      mode: "content",
      capabilityIds: ["google.docs.read"],
    }));

    expect(readResult.ok).toBe(true);
    expect(readResult.contentText).toContain("Read Google Doc Budget.");
    expect(readResult.contentText).toContain("Approved budget summary");
    expect(readResult.contentText).not.toContain("conn_google");
    expect(readResult.contentText).not.toContain("provider-token");
    expect(readResult.contentText).not.toContain("provider-refresh-token");
    expect(JSON.stringify(readResult.data)).not.toContain("conn_google");
    expect(JSON.stringify(readResult.data)).not.toContain("provider-token");
    expect(executorRequests).toEqual([
      {
        provider: "google",
        operation: "read",
        toolName: "connected_app_read",
        sessionId: "session_1",
        turnId: "turn_1",
        userPrompt: "read Google budget doc",
        connectionIds: ["conn_google"],
        capabilityIds: ["google.docs.read"],
        args: {
          provider: "google",
          ref: "google:doc:budget",
          mode: "content",
          capabilityIds: ["google.docs.read"],
        },
      },
    ]);
  });

  test("requires explicit write intent and readback verification", async () => {
    const connectedApp = googleConnectedAppContext();
    const executorRequests: ConnectedAppToolExecutionRequest[] = [];
    const providerDefinitions = createConnectedAppProviderModelToolDefinitions({
      connectedApps: [connectedApp],
      executeConnectedAppTool: async (request) => {
        executorRequests.push(request);
        const writeInput = request.args.input as { patch?: unknown } | undefined;
        if (writeInput?.patch === "Add Q4 update without verification") {
          return {
            ok: true,
            output: "Updated Google Doc without verification.",
            data: {
              ref: "google:doc:budget",
              connectionId: "conn_google",
              accessToken: "oauth provider-token",
            },
          };
        }
        return {
          ok: true,
          output: "Updated and verified Google Doc Budget.",
          data: {
            ref: "google:doc:budget",
            applied: true,
            verification: {
              verified: true,
              readback: {
                ref: "google:doc:budget",
                title: "Budget",
                content: "Approved budget summary with Q4 update",
              },
            },
            connectionId: "conn_google",
            accessToken: "oauth provider-token",
          },
        };
      },
    });
    const write = providerDefinitions.find((definition) => definition.name === "connected_app_write");
    if (!write) throw new Error("connected_app_write missing");

    const missingIntent = await write.execute(actionContext({
      provider: "google",
      operation: "google.docs.update",
      input: { ref: "google:doc:budget", patch: "Add Q4 update" },
      capabilityIds: ["google.docs.write"],
    }));
    const verifiedWrite = await write.execute(actionContext({
      provider: "google",
      operation: "google.docs.update",
      input: { ref: "google:doc:budget", patch: "Add Q4 update" },
      explicitUserIntent: "User asked to add the Q4 update to google:doc:budget.",
      capabilityIds: ["google.docs.write"],
    }));
    const unverifiedWrite = await write.execute(actionContext({
      provider: "google",
      operation: "google.docs.update",
      input: { ref: "google:doc:budget", patch: "Add Q4 update without verification" },
      explicitUserIntent: "User asked to add the Q4 update to google:doc:budget.",
      capabilityIds: ["google.docs.write"],
    }));

    expect(missingIntent.ok).toBe(false);
    expect(missingIntent.contentText).toContain("explicitUserIntent");
    expect(verifiedWrite.ok).toBe(true);
    expect(verifiedWrite.contentText).toContain("Updated and verified Google Doc Budget.");
    expect(verifiedWrite.contentText).toContain("Approved budget summary with Q4 update");
    expect(verifiedWrite.contentText).not.toContain("conn_google");
    expect(verifiedWrite.contentText).not.toContain("provider-token");
    expect(unverifiedWrite.ok).toBe(false);
    expect(unverifiedWrite.contentText).toContain("did not return required readback verification");
    expect(unverifiedWrite.contentText).not.toContain("conn_google");
    expect(unverifiedWrite.contentText).not.toContain("provider-token");
    expect(executorRequests).toEqual([
      {
        provider: "google",
        operation: "write",
        toolName: "connected_app_write",
        sessionId: "session_1",
        turnId: "turn_1",
        userPrompt: "read Google budget doc",
        connectionIds: ["conn_google"],
        capabilityIds: ["google.docs.write"],
        args: {
          provider: "google",
          operation: "google.docs.update",
          input: { ref: "google:doc:budget", patch: "Add Q4 update" },
          explicitUserIntent: "User asked to add the Q4 update to google:doc:budget.",
          capabilityIds: ["google.docs.write"],
        },
      },
      {
        provider: "google",
        operation: "write",
        toolName: "connected_app_write",
        sessionId: "session_1",
        turnId: "turn_1",
        userPrompt: "read Google budget doc",
        connectionIds: ["conn_google"],
        capabilityIds: ["google.docs.write"],
        args: {
          provider: "google",
          operation: "google.docs.update",
          input: { ref: "google:doc:budget", patch: "Add Q4 update without verification" },
          explicitUserIntent: "User asked to add the Q4 update to google:doc:budget.",
          capabilityIds: ["google.docs.write"],
        },
      },
    ]);
  });
});

function googleConnectedAppContext(): ResolvedConnectedAppContext {
  return {
    provider: "google",
    label: "Google",
    appIds: ["google"],
    setupSurfaces: ["oauth_connector"],
    accountLabels: ["Docs User"],
    workspaceLabels: ["Drive"],
    capabilities: [
      { access: "read", id: "google.drive.file.read", label: "Read Drive files" },
      { access: "read", id: "google.docs.read", label: "Read Docs" },
      { access: "write", id: "google.docs.write", label: "Edit Docs" },
    ],
    toolNames: [
      "connected_app_skill_read",
      "connected_app_search",
      "connected_app_read",
      "connected_app_write",
    ],
    connectionIds: ["conn_google"],
  };
}

function actionContext(args: Record<string, unknown>): ModelToolExecutionContext {
  return {
    session: baseSession({ workspaceKind: "sandbox", workspaceId: "sandbox_1" }),
    turnId: "turn_1",
    provider: "openrouter",
    model: "test/model",
    callId: "call_connected_app",
    args,
    signal: new AbortController().signal,
    workspaceDiffBaseline: null,
    mentionedApps: [],
    userPrompt: "read Google budget doc",
  };
}

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_1",
    provider: "openrouter",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    title: "BYOK chat",
    appId: null,
    appName: null,
    workspaceKind: undefined,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-06-30T10:00:00.000Z",
    updatedAt: "2026-06-30T10:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}
