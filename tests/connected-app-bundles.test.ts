import { describe, expect, test } from "bun:test";
import {
  buildConnectedAppInstallUrl,
  buildConnectedAppStatusRows,
  CONNECTED_APP_BUNDLES,
  CONNECTED_APP_CATALOG,
  CONNECTED_APP_INTEGRATION_SKILLS,
  connectedAppBundleByProvider,
  connectedAppById,
  connectedAppIntegrationSkillByProvider,
  connectedAppProviderOperationById,
  connectedAppProviderOperations,
  normalizeConnectedAppProviderFamilyId,
} from "@openpond/contracts";
import {
  CONNECTED_APP_CATALOG as DIRECT_CONNECTED_APP_CATALOG,
} from "@openpond/connected-apps";

const EXPECTED_CATALOG_IDS = [
  "slack",
  "google",
  "github",
  "x",
  "microsoft_teams",
  "mcp",
] as const;

describe("connected app bundles", () => {
  test("contracts re-export the descriptor-only connected app package", () => {
    expect(CONNECTED_APP_CATALOG.map((app) => app.id)).toEqual(EXPECTED_CATALOG_IDS);
    expect(DIRECT_CONNECTED_APP_CATALOG.map((app) => app.id)).toEqual(EXPECTED_CATALOG_IDS);
  });

  test("models Slack and Teams as native ingestion surfaces only", () => {
    const slack = connectedAppBundleByProvider("slack");
    const teams = connectedAppBundleByProvider("microsoft_teams");

    expect(slack?.setupSurfaces.map((surface) => surface.id)).toEqual(["slack"]);
    expect(slack?.setupSurfaces.map((surface) => surface.setupSurface)).toEqual(["native_bot"]);
    expect(slack?.leasePolicy.leaseable).toBe(false);
    expect(slack?.tools).toEqual([]);

    expect(teams?.setupSurfaces.map((surface) => surface.id)).toEqual(["microsoft_teams"]);
    expect(teams?.setupSurfaces.map((surface) => surface.setupSurface)).toEqual(["native_bot"]);
    expect(teams?.leasePolicy.leaseable).toBe(false);
    expect(teams?.tools).toEqual([]);

    expect(normalizeConnectedAppProviderFamilyId("teams")).toBe("microsoft_teams");
    expect(connectedAppById("slack_oauth")).toBeNull();
  });

  test("keeps setup URL behavior for OAuth, native, and MCP surfaces", () => {
    expect(
      buildConnectedAppInstallUrl({
        appId: "google",
        baseUrl: "https://example.com/workspace",
        teamId: "team_1",
      }),
    ).toBe("https://example.com/sandboxes/apps?app=google&teamId=team_1");

    expect(
      buildConnectedAppInstallUrl({
        appId: "microsoft_teams",
        baseUrl: "https://example.com",
      }),
    ).toBe("https://example.com/sandboxes/apps?app=microsoft_teams");

    expect(
      buildConnectedAppInstallUrl({
        appId: "mcp",
        baseUrl: "https://example.com/base",
      }),
    ).toBe("https://example.com/sandboxes/mcp");
  });

  test("projects live integration connections while keeping ingestion-only native surfaces setup-only", () => {
    const rows = buildConnectedAppStatusRows({
      connections: [
        {
          id: "conn_google",
          provider: "google",
          providerAccountName: "Docs User",
          providerWorkspaceName: "Drive",
          scopes: ["drive.readonly"],
          status: "active",
        },
      ],
    });

    const google = rows.find((row) => row.id === "google");
    const teamsNative = rows.find((row) => row.id === "microsoft_teams");

    expect(google).toMatchObject({
      connected: true,
      status: "connected",
      statusLabel: "Connected",
      providerFamily: "google",
    });
    expect(google?.connections[0]).toMatchObject({
      accountLabel: "Docs User",
      workspaceLabel: "Drive",
    });

    expect(teamsNative).toMatchObject({
      connected: false,
      status: "setup_available",
      statusLabel: "Bot setup",
      setupSurface: "native_bot",
    });
  });

  test("every catalog entry has a bundle, icon, capabilities, and setup descriptor", () => {
    for (const app of CONNECTED_APP_CATALOG) {
      const bundle = connectedAppBundleByProvider(app.providerFamily);
      expect(bundle, app.id).toBeTruthy();
      expect(bundle?.setupSurfaces.some((surface) => surface.id === app.id), app.id).toBe(true);
      expect(app.icon, app.id).toMatch(/^\/connected-apps\//);
      expect(app.installLabel.length, app.id).toBeGreaterThan(0);
    }

    for (const bundle of CONNECTED_APP_BUNDLES) {
      expect(bundle.capabilities.length, bundle.id).toBeGreaterThan(0);
      expect(bundle.leasePolicy.allowedCapabilityIds.every((id) =>
        bundle.capabilities.some((capability) => capability.id === id),
      ), bundle.id).toBe(true);
    }

    expect(connectedAppById("teams")?.id).toBe("microsoft_teams");
  });

  test("ships product-owned integration skill instructions for every provider family", () => {
    expect(CONNECTED_APP_INTEGRATION_SKILLS.map((skill) => skill.provider)).toEqual([
      "slack",
      "google",
      "github",
      "x",
      "microsoft_teams",
      "mcp",
    ]);

    for (const bundle of CONNECTED_APP_BUNDLES) {
      const skill = connectedAppIntegrationSkillByProvider(bundle.id);
      expect(skill?.name, bundle.id).toBe(`${bundle.id}-connected-app`);
      expect(skill?.path, bundle.id).toBe(`integration_skills/${bundle.id}.md`);
      if (bundle.id === "slack" || bundle.id === "microsoft_teams") {
        expect(skill?.body, bundle.id).toContain("ingestion/native");
      } else {
        expect(skill?.body, bundle.id).toContain("server-provided");
      }
      expect(skill?.sourceHash, bundle.id).toMatch(/^connected-app-skill:/);
      expect(bundle.skills.some((descriptor) => descriptor.name === skill?.name), bundle.id).toBe(true);
    }

    expect(connectedAppIntegrationSkillByProvider("teams")?.provider).toBe("microsoft_teams");
    expect(connectedAppIntegrationSkillByProvider("mcp")?.body).toContain("team-scoped");
  });

  test("declares native provider tool policy for OAuth providers", () => {
    for (const bundle of CONNECTED_APP_BUNDLES) {
      const toolNames = bundle.tools.map((tool) => tool.name);
      if (bundle.id === "mcp" || bundle.id === "slack" || bundle.id === "microsoft_teams") {
        expect(toolNames, bundle.id).toEqual([]);
        continue;
      }

      expect(toolNames, bundle.id).toEqual(
        expect.arrayContaining(["connected_app_search", "connected_app_read"]),
      );
      const writeCapabilities = bundle.capabilities.filter((capability) => capability.access === "write");
      if (writeCapabilities.length > 0) {
        expect(toolNames, bundle.id).toContain("connected_app_write");
      }
      for (const tool of bundle.tools) {
        expect(tool.capabilityIds.length, `${bundle.id}:${tool.name}`).toBeGreaterThan(0);
        expect(tool.capabilityIds.every((capabilityId) =>
          bundle.capabilities.some((capability) => capability.id === capabilityId),
        ), `${bundle.id}:${tool.name}`).toBe(true);
      }
    }
  });

  test("declares provider operation policy for all current OAuth providers", () => {
    expect(connectedAppProviderOperations("slack")).toEqual([]);
    expect(connectedAppProviderOperations("microsoft_teams")).toEqual([]);
    expect(connectedAppProviderOperations("mcp")).toEqual([]);

    expect(connectedAppProviderOperations("google").map((operation) => operation.id)).toEqual([
      "google.drive.search",
      "google.drive.read_file",
      "google.docs.read",
      "google.comments.read",
      "google.docs.update",
      "google.comments.create",
      "google.comments.resolve",
    ]);
    expect(connectedAppProviderOperations("github").map((operation) => operation.id)).toEqual([
      "github.repo.search",
      "github.issue.search",
      "github.pull_request.search",
      "github.repo.read",
      "github.issue.read",
      "github.pull_request.read",
      "github.issue.create",
      "github.issue.comment",
      "github.issue.update",
      "github.pull_request.comment",
      "github.pull_request.update",
    ]);
    expect(connectedAppProviderOperations("x").map((operation) => operation.id)).toEqual([
      "x.profile.read",
      "x.post.read",
      "x.search.posts",
      "x.mentions.search",
      "x.mention.read",
      "x.post.create",
      "x.reply.create",
    ]);

    for (const provider of ["google", "github", "x"] as const) {
      const bundle = connectedAppBundleByProvider(provider);
      expect(bundle?.operations.length, provider).toBeGreaterThan(0);
      for (const operation of connectedAppProviderOperations(provider)) {
        expect(operation.capabilityIds.length, `${provider}:${operation.id}`).toBeGreaterThan(0);
        expect(operation.capabilityIds.every((capabilityId) =>
          bundle?.capabilities.some((capability) => capability.id === capabilityId),
        ), `${provider}:${operation.id}`).toBe(true);
        if (operation.operation === "write") {
          expect(operation.requiresReadback, operation.id).toBe(true);
          expect(operation.input?.requiredKeys.length, operation.id).toBeGreaterThan(0);
        }
        expect(operation.requiresRuntimeLease, `${provider}:${operation.id}`).toBe(false);
      }
    }

    expect(connectedAppProviderOperationById("x", "x.reply.create")).toMatchObject({
      operation: "write",
      capabilityIds: ["x.reply.write"],
      requiresReadback: true,
      input: { requiredKeys: ["inReplyToRef", "text"] },
    });
    expect(connectedAppProviderOperationById("x", "x.post.read")).toMatchObject({
      operation: "read",
      capabilityIds: ["x.search.read"],
      requiresReadback: false,
      input: { requiredKeys: ["ref"] },
    });
    expect(connectedAppProviderOperationById("github", "github.issue.create")).toMatchObject({
      operation: "write",
      capabilityIds: ["github.issue.write"],
      requiresReadback: true,
      input: { requiredKeys: ["repo", "title", "body"] },
    });
  });
});
