import { describe, expect, test } from "vitest";
import { ProviderSettingsSchema, type Session } from "@openpond/contracts";
import {
  sessionModelSelectionSyncKey,
  shouldForceCloudWorkspaceProviderOpenPond,
} from "../apps/web/src/hooks/useAppShellEffects";
import { activeChatProviderForWorkspace } from "../apps/web/src/hooks/useActiveWorkspaceViewState";
import { hybridWorkspaceSessionMetadata } from "../apps/web/src/lib/workspace-location";

describe("app shell effects", () => {
  test("does not force Hybrid sandbox sessions back to OpenPond", () => {
    expect(
      shouldForceCloudWorkspaceProviderOpenPond(
        session({
          provider: "codex",
          metadata: hybridWorkspaceSessionMetadata(),
        }),
      ),
    ).toBe(false);
  });

  test("still forces non-Hybrid cloud workspaces to OpenPond", () => {
    expect(shouldForceCloudWorkspaceProviderOpenPond(session({ provider: "codex" }))).toBe(true);
    expect(shouldForceCloudWorkspaceProviderOpenPond(session({ provider: "openpond" }))).toBe(false);
    expect(
      shouldForceCloudWorkspaceProviderOpenPond(
        session({
          provider: "codex",
          workspaceKind: "local_project",
          metadata: null,
        }),
      ),
    ).toBe(false);
  });

  test("keeps a Hybrid chat's saved provider in the model picker", () => {
    expect(
      activeChatProviderForWorkspace({
        draftProvider: "codex",
        hasSelectedCloudProject: true,
        selectedSessionHybridWorkspace: true,
      }),
    ).toBe("codex");
    expect(
      activeChatProviderForWorkspace({
        draftProvider: "codex",
        hasSelectedCloudProject: true,
        selectedSessionHybridWorkspace: false,
      }),
    ).toBe("openpond");
  });

  test("resyncs when a selected chat hydrates its saved provider and model", () => {
    const providerSettings = ProviderSettingsSchema.parse({
      providers: {
        openai: {
          enabled: true,
          defaultModel: "gpt-4.1",
          modelOverrides: ["gpt-5.5"],
        },
      },
      statuses: {
        openai: {
          id: "openai",
          displayName: "OpenAI",
          enabled: true,
          available: true,
          defaultModel: "gpt-4.1",
        },
      },
    });
    const beforeHydration = session({
      provider: "openai",
      modelRef: { providerId: "openai", modelId: "gpt-5.5" },
    });
    const afterHydration = session({
      provider: "codex",
      modelRef: { providerId: "codex", modelId: "gpt-5.6-sol" },
    });

    expect(sessionModelSelectionSyncKey(beforeHydration, providerSettings)).not.toBe(
      sessionModelSelectionSyncKey(afterHydration, providerSettings),
    );
    expect(sessionModelSelectionSyncKey(afterHydration, providerSettings)).toContain(
      "\u0000codex\u0000gpt-5.6-sol",
    );
  });
});

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_1",
    provider: "openpond",
    modelRef: null,
    title: "Test session",
    appId: null,
    appName: null,
    workspaceKind: "sandbox",
    workspaceId: "cloud_project_1",
    workspaceName: "Cloud Project",
    localProjectId: null,
    cloudProjectId: "cloud_project_1",
    cloudTeamId: "team_1",
    metadata: null,
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}
