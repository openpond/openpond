import { describe, expect, test } from "bun:test";
import type { MentionedConnectedAppRef, Session } from "@openpond/contracts";
import { resolveConnectedAppContextsForTurn } from "../apps/server/src/runtime/turn-runner";
import { createHostedTurnHelpers } from "../apps/server/src/openpond/hosted-turn-helpers";
import {
  buildConnectedAppIndexContext,
  resolveMentionedConnectedAppContexts,
} from "../apps/server/src/openpond/connected-app-context";

const googleRef: MentionedConnectedAppRef = {
  kind: "integration",
  provider: "google",
  appIds: ["google"],
  setupSurfaces: ["oauth_connector"],
  connectionIds: ["conn_google"],
  capabilities: ["google.drive.file.read", "google.docs.write"],
};

const xRef: MentionedConnectedAppRef = {
  kind: "integration",
  provider: "x",
  appIds: ["x"],
  setupSurfaces: ["oauth_connector"],
  connectionIds: ["conn_x_social"],
  capabilities: ["x.search.read"],
};

describe("connected app server context", () => {
  test("re-resolves mentioned refs against active trusted connections", () => {
    const contexts = resolveMentionedConnectedAppContexts({
      mentionedRefs: [
        googleRef,
        {
          kind: "integration",
          provider: "x",
          appIds: ["x"],
          setupSurfaces: ["oauth_connector"],
          connectionIds: ["conn_x"],
        },
      ],
      connections: [
        {
          id: "conn_google",
          provider: "google",
          providerAccountName: "Docs User",
          providerWorkspaceName: "Drive",
          status: "active",
        },
        {
          id: "conn_x",
          provider: "x",
          providerAccountName: "Social User",
          status: "revoked",
        },
      ],
      toolNamesByProvider: {
        google: ["google_drive_search"],
      },
    });

    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      provider: "google",
      label: "Google",
      accountLabels: ["Docs User"],
      workspaceLabels: ["Drive"],
      connectionIds: ["conn_google"],
      toolNames: ["google_drive_search"],
    });
    expect(contexts[0]?.capabilities.map((capability) => capability.id)).toEqual([
      "google.drive.file.read",
      "google.docs.write",
    ]);
  });

  test("does not expose forged connection ids or unauthorized capabilities", () => {
    expect(
      resolveMentionedConnectedAppContexts({
        mentionedRefs: [
          {
            ...googleRef,
            connectionIds: ["conn_forged"],
          },
        ],
        connections: [
          {
            id: "conn_google",
            provider: "google",
            status: "active",
          },
        ],
      }),
    ).toEqual([]);

    expect(
      resolveMentionedConnectedAppContexts({
        mentionedRefs: [
          {
            ...googleRef,
            capabilities: ["google.admin.secret"],
          },
        ],
        connections: [
          {
            id: "conn_google",
            provider: "google",
            status: "active",
          },
        ],
      }),
    ).toEqual([]);
  });

  test("formats a redacted connected app prompt index", () => {
    const contexts = resolveMentionedConnectedAppContexts({
      mentionedRefs: [googleRef],
      connections: [
        {
          id: "conn_google",
          provider: "google",
          providerAccountName: "Docs User",
          providerWorkspaceName: "Drive",
          status: "active",
        },
      ],
      toolNamesByProvider: {
        google: ["google_drive_search"],
      },
    });

    const context = buildConnectedAppIndexContext(contexts);

    expect(context).toContain("Connected apps available in this turn");
    expect(context).toContain("Google (google)");
    expect(context).toContain("Docs User");
    expect(context).toContain("google_drive_search");
    expect(context).not.toContain("conn_google");
  });

  test("injects the connected app index into hosted system prompts", async () => {
    const contexts = resolveMentionedConnectedAppContexts({
      mentionedRefs: [googleRef],
      connections: [
        {
          id: "conn_google",
          provider: "google",
          providerAccountName: "Docs User",
          status: "active",
        },
      ],
    });
    const helpers = createHostedTurnHelpers({
      appendRuntimeEvent: async () => undefined,
    });

    const prompt = await helpers.hostedSystemPrompt(
      "Base system prompt.",
      "",
      {
        id: "session_connected_apps",
        appId: null,
        cwd: null,
        workspaceId: null,
        workspaceKind: null,
        workspaceName: null,
      } as Session,
      {
        connectedApps: contexts,
        toolInstructionMode: "none",
      },
    );

    expect(prompt).toContain("Base system prompt.");
    expect(prompt).toContain("Connected apps available in this turn");
    expect(prompt).toContain("Google (google)");
    expect(prompt).toContain("tools: none registered");
    expect(prompt).not.toContain("conn_google");
  });

  test("falls back to all-team connections when the session team misses a mentioned app", async () => {
    const calls: unknown[] = [];
    const contexts = await resolveConnectedAppContextsForTurn({
      refs: [xRef],
      cloudTeamId: "team_current",
      listIntegrationConnections: async (input) => {
        calls.push(input);
        if (input.teamId === "team_current") {
          return { teamId: "team_current", connections: [] };
        }
        return {
          teamId: "team_social",
          connections: [
            {
              id: "conn_x_social",
              teamId: "team_social",
              provider: "x",
              providerAccountName: "Social User",
              status: "active",
            },
          ],
        };
      },
    });

    expect(calls).toEqual([
      { teamId: "team_current", status: "active" },
      { status: "active" },
    ]);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      provider: "x",
      connectionIds: ["conn_x_social"],
      accountLabels: ["Social User"],
    });
    expect(contexts[0]?.toolNames).toEqual(
      expect.arrayContaining(["connected_app_skill_read", "connected_app_search"]),
    );
  });
});
