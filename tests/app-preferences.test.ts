import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  AppPreferencesSchema,
  UpdateAppPreferencesRequestSchema,
  type BootstrapPayload,
} from "@openpond/contracts";
import { createOpenPondServer } from "../apps/server/src/index";
import { normalizeAppPreferences } from "../apps/server/src/preferences";

describe("app preferences", () => {
  test("defaults fresh users to OpenPond Chat and preserves explicit model selections", () => {
    expect(normalizeAppPreferences(null)).toMatchObject({
      defaultChatProvider: "openpond",
      defaultChatModel: "openpond-chat",
    });
    expect(normalizeAppPreferences({
      defaultChatProvider: "openpond",
      defaultChatModel: "openpond-chat",
    })).toMatchObject({
      defaultChatProvider: "openpond",
      defaultChatModel: "openpond-chat",
    });
    expect(normalizeAppPreferences({
      defaultChatProvider: "openai",
      defaultChatModel: "gpt-5.6-sol",
    })).toMatchObject({
      defaultChatProvider: "openai",
      defaultChatModel: "gpt-5.6-sol",
    });
  });

  test("parses preference patches without defaulting omitted fields", () => {
    const patch = UpdateAppPreferencesRequestSchema.parse({ openPondCommandAccessMode: "full-access" });
    expect(patch).toEqual({ openPondCommandAccessMode: "full-access" });
    expect(patch).not.toHaveProperty("subagents");
  });

  test("defaults child roles without semantic budgets or review policies", () => {
    const preferences = AppPreferencesSchema.parse({});
    const coding = preferences.subagents.roles.find((role) => role.id === "coding");

    expect(preferences.insightsEnabled).toBe(false);
    expect(preferences.subagents).toMatchObject({
      enabled: true,
      delegationMode: "balanced",
      maxConcurrentRuns: 4,
      maxConcurrentRunsPerProvider: 2,
      maxConcurrentRunsPerWorkspaceTarget: 1,
    });
    expect(coding).toMatchObject({
      isolationMode: "none",
      toolPolicy: "full_tools",
      background: true,
      peerMessages: "goal_scoped",
    });
    expect(preferences.subagents).not.toHaveProperty("maxTokens");
    expect(preferences.subagents).not.toHaveProperty("heartbeatIntervalSeconds");
    expect(coding).not.toHaveProperty("maxTurns");
    expect(coding).not.toHaveProperty("maxTokens");
    expect(coding).not.toHaveProperty("reviewRouting");
    expect(coding).not.toHaveProperty("explorationSteering");
  });

  test("persists lean subagent settings through bootstrap", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "openpond-preferences-test-"));
    const server = await createOpenPondServer({ host: "127.0.0.1", port: 0, storeDir });
    try {
      const updated = await api<Pick<BootstrapPayload, "preferences">>(server.url, server.token, "/v1/preferences", {
        method: "PATCH",
        body: JSON.stringify({
          subagents: {
            delegationMode: "proactive",
            maxConcurrentRuns: 3,
            maxConcurrentRunsPerProvider: 1,
            maxConcurrentRunsPerWorkspaceTarget: 1,
          },
        }),
      });
      expect(updated.preferences.subagents).toMatchObject({
        delegationMode: "proactive",
        maxConcurrentRuns: 3,
        maxConcurrentRunsPerProvider: 1,
        maxConcurrentRunsPerWorkspaceTarget: 1,
      });

      const bootstrap = await api<BootstrapPayload>(server.url, server.token, "/v1/bootstrap?ensureProfile=0");
      expect(bootstrap.preferences.subagents.delegationMode).toBe("proactive");
    } finally {
      await server.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});

async function api<T>(
  serverUrl: string,
  token: string,
  route: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${serverUrl}${route}`, { ...init, headers });
  if (!response.ok) throw new Error(`${route} failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
