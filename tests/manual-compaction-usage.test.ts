import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { RuntimeEvent, Session, UsageRecordsResponse } from "@openpond/contracts";

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

describe("manual context compaction usage", () => {
  test("records manual hosted compaction usage as a session-level background row", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "openpond-manual-compaction-usage-"));
    const session = sessionFixture("session_manual_compaction");
    const store = new SqliteStore(storeDir);
    await store.mutate((data) => {
      data.sessions.push(session);
      data.events.push(...compactionEvents(session.id));
    });
    await store.close();

    const server = await createOpenPondServer({
      port: 0,
      storeDir,
      silent: true,
      version: "manual-compaction-usage-test",
      streamOpenPondHostedChatTurn: async function* () {
        yield {
          type: "text_delta",
          text: [
            "Goal: preserve support workflow state.",
            "Next Steps: continue from compacted state.",
          ].join("\n"),
          raw: {},
        } as any;
        yield {
          type: "usage",
          usage: { prompt_tokens: 88, completion_tokens: 11, total_tokens: 99 },
          raw: {},
        } as any;
      },
    });

    try {
      const compacted = await api<{
        ok: boolean;
        mode: string;
        summaryEventId: string | null;
      }>(
        server.url,
        server.token,
        `/v1/sessions/${encodeURIComponent(session.id)}/compact`,
        {
          method: "POST",
          body: JSON.stringify({ reason: "manual", model: "openpond-manual-test" }),
        },
      );
      expect(compacted).toMatchObject({
        ok: true,
        mode: "summary",
      });
      expect(compacted.summaryEventId).not.toBeNull();

      const usage = await api<UsageRecordsResponse>(
        server.url,
        server.token,
        "/v1/usage/records?range=all&limit=10",
      );
      expect(usage.records).toHaveLength(1);
      expect(usage.records[0]).toMatchObject({
        sessionId: session.id,
        turnId: null,
        provider: "openpond",
        model: "openpond-manual-test",
        route: "openpond_hosted",
        source: "provider_usage",
        requestKind: "context_compaction",
        visibility: "background",
        status: "completed",
        requestOrdinal: 0,
        promptTokens: 88,
        completionTokens: 11,
        totalTokens: 99,
        attribution: {
          surface: "compaction",
          workflowKind: "summary",
          sessionId: session.id,
          turnId: null,
        },
      });
      expect(usage.records[0]?.requestId).toContain(`${session.id}:context-compaction:`);
      expect(usage.records[0]?.firstTokenMs).not.toBeNull();
      expect("rawUsage" in usage.records[0]!).toBe(false);
    } finally {
      await server.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  }, 10_000);
});

function sessionFixture(id: string): Session {
  return {
    id,
    provider: "openpond",
    modelRef: { providerId: "openpond", modelId: "openpond-chat" },
    title: "Manual compaction usage",
    appId: null,
    appName: null,
    workspaceKind: "local_project",
    workspaceId: "project_manual_compaction",
    workspaceName: "Manual Compaction Project",
    localProjectId: "project_manual_compaction",
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: "/tmp/openpond",
    codexThreadId: null,
    createdAt: "2026-07-04T12:00:00.000Z",
    updatedAt: "2026-07-04T12:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
  };
}

function compactionEvents(sessionId: string): RuntimeEvent[] {
  return [
    {
      id: "manual_prior_turn_1_started",
      sessionId,
      turnId: "manual_prior_turn_1",
      name: "turn.started",
      timestamp: "2026-07-04T12:01:00.000Z",
      source: "server",
      args: { prompt: "Preserve the support workflow requirements." },
    },
    {
      id: "manual_prior_turn_1_assistant",
      sessionId,
      turnId: "manual_prior_turn_1",
      name: "assistant.delta",
      timestamp: "2026-07-04T12:01:01.000Z",
      source: "provider",
      output: "Support workflow requirements are captured.",
    },
    {
      id: "manual_prior_turn_2_started",
      sessionId,
      turnId: "manual_prior_turn_2",
      name: "turn.started",
      timestamp: "2026-07-04T12:02:00.000Z",
      source: "server",
      args: { prompt: "Keep the latest notes outside the summary." },
    },
    {
      id: "manual_prior_turn_2_assistant",
      sessionId,
      turnId: "manual_prior_turn_2",
      name: "assistant.delta",
      timestamp: "2026-07-04T12:02:01.000Z",
      source: "provider",
      output: "Latest notes stay in the preserved tail.",
    },
  ];
}
