import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { BootstrapPayload } from "@openpond/contracts";
import {
  AppPreferencesSchema,
  SUBAGENT_DEFAULT_HIGH_RISK_PATH_PATTERNS,
  UpdateAppPreferencesRequestSchema,
  type AppPreferences,
} from "@openpond/contracts";

import { APP_PREFERENCES_CACHE_KEY, APP_PREFERENCES_CACHE_TYPE } from "../apps/server/src/constants";
import { createOpenPondServer } from "../apps/server/src/index";
import { SqliteStore } from "../apps/server/src/store/store";

async function api<T>(
  serverUrl: string,
  token: string,
  route: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${serverUrl}${route}`, { ...init, headers });
  if (!response.ok) throw new Error(`${route} failed: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

describe("app preferences", () => {
  test("parses preference patches without applying defaults for omitted fields", () => {
    const patch = UpdateAppPreferencesRequestSchema.parse({
      openPondCommandAccessMode: "full-access",
    });
    expect(patch).toEqual({ openPondCommandAccessMode: "full-access" });
  });

  test("defaults subagent role settings to direct shared-workspace workers", () => {
    const preferences = AppPreferencesSchema.parse({});
    const coding = preferences.subagents.roles.find((role) => role.id === "coding");
    const research = preferences.subagents.roles.find((role) => role.id === "research");
    expect(preferences.subagents.enabled).toBe(true);
    expect(preferences.subagents.delegationMode).toBe("balanced");
    expect(preferences.subagents.maxConcurrentRuns).toBe(4);
    expect(preferences.subagents.maxConcurrentRunsPerProvider).toBe(2);
    expect(preferences.subagents.maxConcurrentRunsPerWorkspaceTarget).toBe(1);
    expect(preferences.subagents.heartbeatIntervalSeconds).toBe(60);
    expect(coding?.reviewRouting).toEqual({
      broadEditSurfaceFileThreshold: 8,
      highRiskPathPatterns: [...SUBAGENT_DEFAULT_HIGH_RISK_PATH_PATTERNS],
    });
    expect(coding?.explorationSteering).toEqual({
      enabled: true,
      repeatedSearchThreshold: 2,
      repeatedReadThreshold: 2,
      repeatedCommandThreshold: 2,
    });
    expect(coding).toMatchObject({
      enabled: true,
      isolationMode: "none",
      toolPolicy: "workspace_write",
      background: true,
      peerMessages: "goal_scoped",
      modelRef: null,
    });
    expect(research).toMatchObject({
      isolationMode: "none",
      toolPolicy: "read_only",
      background: true,
    });
    expect(AppPreferencesSchema.parse({ subagents: { heartbeatIntervalSeconds: 10 } }).subagents.heartbeatIntervalSeconds).toBe(10);
    expect(AppPreferencesSchema.parse({ subagents: { heartbeatIntervalSeconds: 3600 } }).subagents.heartbeatIntervalSeconds).toBe(3600);
    expect(() => AppPreferencesSchema.parse({ subagents: { heartbeatIntervalSeconds: 9 } })).toThrow();
    expect(() => AppPreferencesSchema.parse({ subagents: { heartbeatIntervalSeconds: 3601 } })).toThrow();
    expect(AppPreferencesSchema.parse({ subagents: { delegationMode: "proactive" } }).subagents.delegationMode).toBe("proactive");
    expect(() => AppPreferencesSchema.parse({ subagents: { delegationMode: "always" } })).toThrow();
    const tunedCoding = AppPreferencesSchema.parse({
      subagents: {
        roles: [{
          id: "coding",
          reviewRouting: {
            broadEditSurfaceFileThreshold: 3,
            highRiskPathPatterns: ["(^|/)src/critical(/|$)"],
          },
          explorationSteering: {
            repeatedSearchThreshold: 4,
            repeatedReadThreshold: 5,
            repeatedCommandThreshold: 6,
          },
        }],
      },
    }).subagents.roles.find((role) => role.id === "coding");
    expect(tunedCoding?.reviewRouting).toEqual({
      broadEditSurfaceFileThreshold: 3,
      highRiskPathPatterns: ["(^|/)src/critical(/|$)"],
    });
    expect(tunedCoding?.explorationSteering).toEqual({
      enabled: true,
      repeatedSearchThreshold: 4,
      repeatedReadThreshold: 5,
      repeatedCommandThreshold: 6,
    });
    expect(() =>
      AppPreferencesSchema.parse({
        subagents: {
          roles: [{
            id: "coding",
            reviewRouting: {
              highRiskPathPatterns: ["["],
            },
          }],
        },
      })
    ).toThrow();
    expect(() =>
      AppPreferencesSchema.parse({
        subagents: {
          roles: [{
            id: "coding",
            explorationSteering: {
              repeatedSearchThreshold: 1,
            },
          }],
        },
      })
    ).toThrow();
  });

  test("normalizes subagent defaults for new, legacy, and partial preference records", async () => {
    const emptyStoreDir = await mkdtemp(join(tmpdir(), "openpond-subagent-empty-preferences-"));
    const emptyServer = await createOpenPondServer({
      port: 0,
      storeDir: emptyStoreDir,
      silent: true,
      version: "subagent-empty-preferences-test",
    });
    try {
      const bootstrap = await api<BootstrapPayload>(
        emptyServer.url,
        emptyServer.token,
        "/v1/bootstrap?ensureProfile=0",
      );
      expect(bootstrap.preferences.subagents.heartbeatIntervalSeconds).toBe(60);
      expect(bootstrap.preferences.subagents.roles.find((role) => role.id === "coding")).toMatchObject({
        isolationMode: "none",
        toolPolicy: "workspace_write",
        reviewRouting: {
          broadEditSurfaceFileThreshold: 8,
          highRiskPathPatterns: [...SUBAGENT_DEFAULT_HIGH_RISK_PATH_PATTERNS],
        },
        explorationSteering: {
          enabled: true,
          repeatedSearchThreshold: 2,
          repeatedReadThreshold: 2,
          repeatedCommandThreshold: 2,
        },
      });
    } finally {
      await emptyServer.close();
      await rm(emptyStoreDir, { recursive: true, force: true });
    }

    const legacyStoreDir = await mkdtemp(join(tmpdir(), "openpond-subagent-legacy-preferences-"));
    const legacyStore = new SqliteStore(legacyStoreDir);
    try {
      await legacyStore.setCacheEntry(APP_PREFERENCES_CACHE_TYPE, APP_PREFERENCES_CACHE_KEY, {
        defaultChatProvider: "openrouter",
        defaultChatModel: "test/model",
        subagents: {
          enabled: true,
          roles: [
            {
              id: "coding",
              toolPolicy: "workspace_write",
            },
          ],
          maxConcurrentRuns: 3,
        },
      });
    } finally {
      await legacyStore.close();
    }

    const legacyServer = await createOpenPondServer({
      port: 0,
      storeDir: legacyStoreDir,
      silent: true,
      version: "subagent-legacy-preferences-test",
    });
    try {
      const bootstrap = await api<BootstrapPayload>(
        legacyServer.url,
        legacyServer.token,
        "/v1/bootstrap?ensureProfile=0",
      );
      expect(bootstrap.preferences.subagents.heartbeatIntervalSeconds).toBe(60);
      expect(bootstrap.preferences.subagents.maxConcurrentRuns).toBe(3);
      expect(bootstrap.preferences.subagents.roles.find((role) => role.id === "coding")).toMatchObject({
        isolationMode: "none",
        maxConcurrentRuns: 1,
        maxTurns: null,
        maxTokens: null,
        toolPolicy: "workspace_write",
        background: true,
        peerMessages: "goal_scoped",
        reviewRouting: {
          broadEditSurfaceFileThreshold: 8,
          highRiskPathPatterns: [...SUBAGENT_DEFAULT_HIGH_RISK_PATH_PATTERNS],
        },
        explorationSteering: {
          enabled: true,
          repeatedSearchThreshold: 2,
          repeatedReadThreshold: 2,
          repeatedCommandThreshold: 2,
        },
      });
      expect(bootstrap.preferences.subagents.roles.find((role) => role.id === "review")).toBeTruthy();

      const saved = await api<{ preferences: AppPreferences }>(
        legacyServer.url,
        legacyServer.token,
        "/v1/preferences",
        {
          method: "PATCH",
          body: JSON.stringify({
            defaultBranchPrefix: "feat/subagent-",
          }),
        },
      );
      expect(saved.preferences.defaultBranchPrefix).toBe("feat/subagent-");
      expect(saved.preferences.subagents.heartbeatIntervalSeconds).toBe(60);
      expect(saved.preferences.subagents.maxConcurrentRuns).toBe(3);
      expect(saved.preferences.subagents.roles.find((role) => role.id === "review")).toBeTruthy();
    } finally {
      await legacyServer.close();
      await rm(legacyStoreDir, { recursive: true, force: true });
    }
  }, 20_000);

  test("migrates legacy Codex gpt-5.5 main chat while preserving Z.ai coding subagent settings", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "openpond-subagent-preferences-"));
    const server = await createOpenPondServer({
      port: 0,
      storeDir,
      silent: true,
      version: "subagent-preferences-test",
    });

    try {
      const saved = await api<{ preferences: AppPreferences }>(
        server.url,
        server.token,
        "/v1/preferences",
        {
          method: "PATCH",
          body: JSON.stringify({
            defaultChatProvider: "codex",
            defaultChatModel: "gpt-5.5",
            subagents: {
              enabled: true,
              maxConcurrentRuns: 4,
              maxConcurrentRunsPerProvider: 2,
              maxConcurrentRunsPerWorkspaceTarget: 2,
              maxTokens: null,
              roles: [
                {
                  id: "coding",
                  modelRef: { providerId: "zai", modelId: "glm-5.2" },
                  isolationMode: "copy_on_write",
                  maxConcurrentRuns: 1,
                  maxTurns: null,
                  maxTokens: null,
                  toolPolicy: "workspace_write",
                  background: true,
                  peerMessages: "goal_scoped",
                },
              ],
            },
          }),
        },
      );

      expect(saved.preferences.defaultChatProvider).toBe("codex");
      expect(saved.preferences.defaultChatModel).toBe("gpt-5.6-sol");
      expect(saved.preferences.codexReasoningEffort).toBe("low");
      expect(saved.preferences.subagents.roles.find((role) => role.id === "coding")?.modelRef).toEqual({
        providerId: "zai",
        modelId: "glm-5.2",
      });
      expect(saved.preferences.subagents.roles.find((role) => role.id === "review")).toBeTruthy();

      const bootstrap = await api<BootstrapPayload>(
        server.url,
        server.token,
        "/v1/bootstrap?ensureProfile=0",
      );
      expect(bootstrap.preferences.subagents).toEqual(saved.preferences.subagents);
    } finally {
      await server.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  }, 20_000);

  test("persists the auto context compaction toggle through bootstrap", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "openpond-context-compaction-preferences-"));
    const server = await createOpenPondServer({
      port: 0,
      storeDir,
      silent: true,
      version: "context-compaction-preferences-test",
    });

    try {
      const saved = await api<{ preferences: AppPreferences }>(
        server.url,
        server.token,
        "/v1/preferences",
        {
          method: "PATCH",
          body: JSON.stringify({
            contextCompaction: {
              autoEnabled: false,
              triggerPercent: 85,
              summaryModel: "same_model",
            },
          }),
        },
      );
      expect(saved.preferences.contextCompaction).toEqual({
        autoEnabled: false,
        triggerPercent: 85,
        summaryModel: "same_model",
      });

      const bootstrap = await api<BootstrapPayload>(
        server.url,
        server.token,
        "/v1/bootstrap?ensureProfile=0",
      );
      expect(bootstrap.preferences.contextCompaction).toEqual(saved.preferences.contextCompaction);
    } finally {
      await server.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  }, 20_000);

  test("merges sequential partial preference patches without resetting unrelated preferences", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "openpond-partial-preferences-"));
    const server = await createOpenPondServer({
      port: 0,
      storeDir,
      silent: true,
      version: "partial-preferences-test",
    });

    try {
      const codex = await api<{ preferences: AppPreferences }>(
        server.url,
        server.token,
        "/v1/preferences",
        {
          method: "PATCH",
          body: JSON.stringify({
            codexPermissionMode: "auto-review",
            codexReasoningEffort: "xhigh",
          }),
        },
      );
      expect(codex.preferences.codexPermissionMode).toBe("auto-review");
      expect(codex.preferences.codexReasoningEffort).toBe("xhigh");

      const commandAccess = await api<{ preferences: AppPreferences }>(
        server.url,
        server.token,
        "/v1/preferences",
        {
          method: "PATCH",
          body: JSON.stringify({
            openPondCommandAccessMode: "full-access",
          }),
        },
      );
      expect(commandAccess.preferences.openPondCommandAccessMode).toBe("full-access");
      expect(commandAccess.preferences.codexPermissionMode).toBe("auto-review");
      expect(commandAccess.preferences.codexReasoningEffort).toBe("xhigh");

      const bootstrap = await api<BootstrapPayload>(
        server.url,
        server.token,
        "/v1/bootstrap?ensureProfile=0",
      );
      expect(bootstrap.preferences.openPondCommandAccessMode).toBe("full-access");
      expect(bootstrap.preferences.codexPermissionMode).toBe("auto-review");
      expect(bootstrap.preferences.codexReasoningEffort).toBe("xhigh");
    } finally {
      await server.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  }, 20_000);
});
