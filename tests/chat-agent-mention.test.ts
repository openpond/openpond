import { describe, expect, test } from "bun:test";

import {
  buildConnectedAppStatusRows,
  SendTurnRequestSchema,
} from "@openpond/contracts";
import { resolveMentionedChatApp } from "../apps/web/src/lib/chat-app-mentions";
import {
  actionMentionMatchesForQuery,
  resolveMentionedAction,
} from "../apps/web/src/lib/action-mentions";
import {
  connectedAppMentionMatchesForQuery,
  connectedAppMentionOptionsFromStatusRows,
  resolveMentionedConnectedApps,
} from "../apps/web/src/lib/connected-app-mentions";
import { hasGitHubIssueSubmitConnection } from "../apps/web/src/lib/submit-issue-command";

const apps = [
  {
    id: "app_alpha",
    name: "Alpha Bot",
  },
  {
    id: "app_beta",
    name: "beta-agent",
  },
] as never;

describe("chat app mention resolution", () => {
  test("resolves a single app id mention", () => {
    expect(resolveMentionedChatApp("use @app_beta for this sandbox", apps)?.id).toBe(
      "app_beta",
    );
  });

  test("resolves a single normalized app name mention", () => {
    expect(resolveMentionedChatApp("start @alpha-bot", apps)?.id).toBe(
      "app_alpha",
    );
  });

  test("does not choose an app when mentions are ambiguous", () => {
    expect(resolveMentionedChatApp("@app_alpha compare with @app_beta", apps)).toBeNull();
  });
});

const supportAction = {
  id: "help-me-keep-track-of-open-customer-support-item.chat",
  label: "Chat",
  description: "Track, summarize, and filter open customer support items from committed local fixtures.",
  implementation: {
    type: "openpond-profile-action",
    actionId: "help-me-keep-track-of-open-customer-support-item.chat",
  },
};

describe("profile action mention resolution", () => {
  test("resolves generated profile actions by profile-qualified action id", () => {
    const resolved = resolveMentionedAction(
      "@help-me-keep-track-of-open-customer-support-item Which open customer support items need attention first?",
      [supportAction],
    );

    expect(resolved?.action.id).toBe("help-me-keep-track-of-open-customer-support-item.chat");
    expect(resolved?.mention).toBe("help-me-keep-track-of-open-customer-support-item");
    expect(resolved?.prompt).toBe("Which open customer support items need attention first?");
  });

  test("finds generated support actions by useful catalog aliases", () => {
    expect(actionMentionMatchesForQuery([supportAction], "support").map((action) => action.id)).toEqual([
      "help-me-keep-track-of-open-customer-support-item.chat",
    ]);
    expect(resolveMentionedAction("@support summarize open issues", [supportAction])?.action.id).toBe(
      "help-me-keep-track-of-open-customer-support-item.chat",
    );
  });

  test("does not choose an action when mentions are ambiguous", () => {
    const billingSupportAction = {
      id: "billing-support.chat",
      label: "Billing Support",
      description: "Summarize billing support escalations.",
      implementation: {
        type: "openpond-profile-action",
        actionId: "billing-support.chat",
      },
    };

    expect(resolveMentionedAction("@support summarize open issues", [supportAction, billingSupportAction])).toBeNull();
  });
});

describe("connected app mention resolution", () => {
  test("builds mention options only from connected integration rows", () => {
    const options = connectedAppMentionOptionsFromStatusRows(
      buildConnectedAppStatusRows({
        connections: [
          {
            id: "conn_google",
            provider: "google",
            providerAccountName: "Docs User",
            providerWorkspaceName: "Drive",
            status: "active",
          },
          {
            id: "conn_teams",
            provider: "microsoft_teams",
            providerAccountName: "Teams User",
            providerWorkspaceName: "Water Ops",
            status: "active",
          },
          {
            id: "conn_x",
            provider: "x",
            providerAccountName: "Social User",
            status: "active",
          },
        ],
      }),
    );

    expect(options.map((option) => option.provider)).toEqual(["google", "x"]);
    expect(options.find((option) => option.provider === "microsoft_teams")).toBeUndefined();
    expect(options.find((option) => option.provider === "google")?.ref).toMatchObject({
      kind: "integration",
      provider: "google",
      appIds: ["google"],
      setupSurfaces: ["oauth_connector"],
      connectionIds: ["conn_google"],
    });
  });

  test("matches provider aliases and resolves structured turn refs", () => {
    const options = connectedAppMentionOptionsFromStatusRows(
      buildConnectedAppStatusRows({
        connections: [
          { id: "conn_google", provider: "google", status: "active" },
          { id: "conn_x", provider: "x", status: "active" },
        ],
      }),
    );

    expect(connectedAppMentionMatchesForQuery(options, "drive").map((option) => option.provider)).toEqual([
      "google",
    ]);
    expect(connectedAppMentionMatchesForQuery(options, "twitter").map((option) => option.provider)).toEqual(["x"]);

    const refs = resolveMentionedConnectedApps("Use @drive and @twitter for this", options)
      .map((option) => option.ref);

    expect(refs.map((ref) => ref.provider)).toEqual(["google", "x"]);
    expect(SendTurnRequestSchema.parse({
      prompt: "Use @drive and @twitter for this",
      mentionedConnectedApps: refs,
    }).mentionedConnectedApps).toEqual(refs);
  });

  test("detects GitHub issue-submit readiness from active connected app status", () => {
    const options = connectedAppMentionOptionsFromStatusRows(
      buildConnectedAppStatusRows({
        connections: [
          { id: "conn_github", provider: "github", status: "active" },
        ],
      }),
    );

    expect(hasGitHubIssueSubmitConnection(options)).toBe(true);
    expect(hasGitHubIssueSubmitConnection([])).toBe(false);
  });
});
