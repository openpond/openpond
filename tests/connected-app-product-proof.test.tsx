import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildConnectedAppInstallUrl,
  buildConnectedAppStatusRows,
  CONNECTED_APP_CATALOG,
  connectedAppBundleByProvider,
  type ConnectedAppId,
} from "@openpond/contracts";

import {
  ConnectedAppRow,
  connectedAppSetupTeamId,
} from "../apps/web/src/components/apps/AppsView";
import { useAppConversationContext } from "../apps/web/src/hooks/useAppConversationContext";
import { buildRuntimeIndexes } from "../apps/web/src/lib/runtime-indexes";
import { ComposerMentionMenu } from "../apps/web/src/components/chat/ComposerMentionMenu";
import {
  connectedAppMentionOptionsFromStatusRows,
  connectedAppMentionMatchesForQuery,
  detectConnectedAppMentionRanges,
} from "../apps/web/src/lib/connected-app-mentions";

const noop = () => undefined;

describe("connected app product proof", () => {
  test("renders connected OAuth providers in Apps status without exposing ingestion-only Teams as connected", () => {
    const rows = productProofStatusRows();
    const google = row(rows, "google");
    const x = row(rows, "x");
    const teams = row(rows, "microsoft_teams");

    const googleMarkup = renderToStaticMarkup(
      createElement(ConnectedAppRow, {
        app: google,
        onSelect: noop,
      }),
    );
    const teamsMarkup = renderToStaticMarkup(
      createElement(ConnectedAppRow, {
        app: teams,
        onSelect: noop,
      }),
    );

    expect(googleMarkup).toContain("Google");
    expect(googleMarkup).toContain("OAuth connector");
    expect(googleMarkup).toContain("Connected");
    expect(googleMarkup).toContain("Read Drive files");
    expect(googleMarkup).toContain("Write Drive files");
    expect(googleMarkup).not.toContain("conn_google");
    expect(x.connections[0]?.teamId).toBe("team_social");

    expect(teamsMarkup).toContain("Teams");
    expect(teamsMarkup).toContain("Native app");
    expect(teamsMarkup).toContain("Bot setup");
    expect(teamsMarkup).toContain("Ingest messages");
    expect(teamsMarkup).not.toContain("Connected");
  });

  test("renders connected OAuth providers in composer mention results while excluding native Teams", () => {
    const options = connectedAppMentionOptionsFromStatusRows(productProofStatusRows());
    const driveMatches = connectedAppMentionMatchesForQuery(options, "drive");
    const twitterMatches = connectedAppMentionMatchesForQuery(options, "twitter");
    const mentionItems = [...driveMatches, ...twitterMatches].map((app) => ({
      kind: "connected-app" as const,
      app,
    }));

    const markup = renderToStaticMarkup(
      createElement(ComposerMentionMenu, {
        items: mentionItems,
        mentionIndex: 0,
        onSelect: noop,
        onSelectIndex: noop,
        style: {},
      }),
    );

    expect(options.map((option) => option.provider)).toEqual(["google", "github", "x"]);
    expect(markup).toContain("Google");
    expect(markup).toContain("./connected-apps/google.svg");
    expect(markup).toContain("Read Drive files");
    expect(markup).toContain("X");
    expect(markup).toContain("./connected-apps/x.svg");
    expect(markup).toContain("Read profile");
    expect(markup).not.toContain("Microsoft Teams");
    expect(markup).not.toContain("conn_google");
    expect(markup).not.toContain("conn_x");
  });

  test("keeps connected app mentions available inside scoped project chats", () => {
    const markup = renderToStaticMarkup(
      createElement(ScopedConversationProbe),
    );

    expect(markup).toContain("connected:google,github,x");
    expect(markup).toContain("apps:0");
  });

  test("decorates connected app mentions with canonical display labels while preserving prompt text", () => {
    const options = connectedAppMentionOptionsFromStatusRows(productProofStatusRows());

    expect(
      detectConnectedAppMentionRanges("Ask @twitter to search and @github to inspect issues", options)
        .map((range) => ({
          displayText: range.displayText,
          provider: range.provider,
          text: range.text,
        })),
    ).toEqual([
      { displayText: "@X", provider: "x", text: "@twitter" },
      { displayText: "@GitHub", provider: "github", text: "@github" },
    ]);
  });

  test("renders every catalog entry with visible status, capabilities, and execution policy", () => {
    const rows = productProofStatusRows();

    expect(rows.map((candidate) => candidate.id)).toEqual(
      CONNECTED_APP_CATALOG.map((candidate) => candidate.id),
    );

    for (const app of rows) {
      const bundle = connectedAppBundleByProvider(app.providerFamily);
      const markup = renderToStaticMarkup(
        createElement(ConnectedAppRow, {
          app,
          onSelect: noop,
        }),
      );

      expect(bundle, app.id).toBeTruthy();
      expect(app.capabilityLabels.length, app.id).toBeGreaterThan(0);
      expect(markup, app.id).toContain(app.label);
      expect(markup, app.id).toContain(app.setupSurfaceLabel);
      expect(markup, app.id).toContain(app.statusLabel);
      expect(markup, app.id).toContain(app.capabilityLabels[0]!);
      expect(markup, app.id).not.toContain("conn_");

      if (isLeaseableOAuthCatalogId(app.id)) {
        expect(app.connected, app.id).toBe(true);
        expect(app.statusLabel, app.id).toBe("Connected");
        expect(bundle?.leasePolicy.leaseable, app.id).toBe(true);
        expect(bundle?.tools.map((tool) => tool.name), app.id).toEqual([
          "connected_app_search",
          "connected_app_read",
          "connected_app_write",
        ]);
      } else {
        expect(app.connected, app.id).toBe(false);
        expect(bundle?.leasePolicy.leaseable, app.id).toBe(false);
        expect(bundle?.tools, app.id).toEqual([]);
      }
    }
  });

  test("scopes setup URLs to the resolved status team when preferences have no default team", () => {
    const statusTeamId = " team_from_status ";
    const fallbackTeamId = connectedAppSetupTeamId(null, statusTeamId);
    const explicitTeamId = connectedAppSetupTeamId(" team_from_preferences ", statusTeamId);

    expect(fallbackTeamId).toBe("team_from_status");
    expect(explicitTeamId).toBe("team_from_preferences");

    const fallbackUrl = new URL(
      buildConnectedAppInstallUrl({
        appId: "x",
        baseUrl: "https://staging.openpond.ai",
        teamId: fallbackTeamId,
      }),
    );
    const explicitUrl = new URL(
      buildConnectedAppInstallUrl({
        appId: "github",
        baseUrl: "https://staging.openpond.ai",
        teamId: explicitTeamId,
      }),
    );

    expect(fallbackUrl.pathname).toBe("/sandboxes/apps");
    expect(fallbackUrl.searchParams.get("app")).toBe("x");
    expect(fallbackUrl.searchParams.get("teamId")).toBe("team_from_status");
    expect(explicitUrl.searchParams.get("app")).toBe("github");
    expect(explicitUrl.searchParams.get("teamId")).toBe("team_from_preferences");
  });
});

function ScopedConversationProbe() {
  const context = useAppConversationContext({
    bootstrap: null,
    connectedAppRows: productProofStatusRows(),
    mentionableSandboxApps: [{ id: "app_alpha", name: "Alpha" }] as never,
    runtimeIndexes: buildRuntimeIndexes([], []),
    selectedApp: null,
    selectedCloudProject: null,
    selectedProject: { id: "local_project_1" } as never,
    selectedSession: null,
    selectedSessionId: null,
  });

  return createElement(
    "span",
    null,
    `connected:${context.connectedAppMentions.map((option) => option.provider).join(",")};apps:${context.chatMentionApps.length}`,
  );
}

function productProofStatusRows() {
  return buildConnectedAppStatusRows({
    connections: [
      {
        id: "conn_google",
        teamId: "team_docs",
        provider: "google",
        providerAccountName: "Docs User",
        providerWorkspaceName: "Drive",
        status: "active",
      },
      {
        id: "conn_github",
        teamId: "team_code",
        provider: "github",
        providerAccountName: "Git User",
        providerWorkspaceName: "openpond",
        status: "active",
      },
      {
        id: "conn_x",
        teamId: "team_social",
        provider: "x",
        providerAccountName: "Social User",
        status: "active",
      },
      {
        id: "conn_teams",
        provider: "microsoft_teams",
        providerAccountName: "Teams User",
        providerWorkspaceName: "Water Ops",
        status: "active",
      },
    ],
  });
}

function row(rows: ReturnType<typeof productProofStatusRows>, id: string) {
  const app = rows.find((candidate) => candidate.id === id);
  if (!app) throw new Error(`Missing connected app row: ${id}`);
  return app;
}

function isLeaseableOAuthCatalogId(id: ConnectedAppId): boolean {
  return id === "google" || id === "github" || id === "x";
}
