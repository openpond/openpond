import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { BootstrapPayload } from "@openpond/contracts";
import {
  AppPreferencesSchema,
  UpdateAppPreferencesRequestSchema,
  type AppPreferences,
} from "@openpond/contracts";

import { createOpenPondServer } from "../apps/server/src/index";

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

  test("defaults subagent role settings with copy-on-write background workers", () => {
    const preferences = AppPreferencesSchema.parse({});
    const coding = preferences.subagents.roles.find((role) => role.id === "coding");
    const research = preferences.subagents.roles.find((role) => role.id === "research");
    expect(preferences.subagents.enabled).toBe(true);
    expect(preferences.subagents.maxConcurrentRuns).toBe(4);
    expect(preferences.subagents.maxConcurrentRunsPerProvider).toBe(2);
    expect(preferences.subagents.maxConcurrentRunsPerWorkspaceTarget).toBe(2);
    expect(coding).toMatchObject({
      enabled: true,
      isolationMode: "copy_on_write",
      toolPolicy: "workspace_write",
      background: true,
      peerMessages: "goal_scoped",
      modelRef: null,
    });
    expect(research).toMatchObject({
      isolationMode: "copy_on_write",
      toolPolicy: "read_only",
      background: true,
    });
  });

  test("persists gpt-5.5 main chat with Z.ai coding subagent settings", async () => {
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
      expect(saved.preferences.defaultChatModel).toBe("gpt-5.5");
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
  });

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
  });

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
  });
});
