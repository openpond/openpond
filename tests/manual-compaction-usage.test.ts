import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { RuntimeEvent, Session, UsageRecordsResponse } from "@openpond/contracts";

import { createOpenPondServer } from "../apps/server/src/index";
import { SqliteStore } from "../apps/server/src/store/store";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.OPENPOND_TEST_ZAI_KEY;
});

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

      const snapshot = await serverSnapshot(storeDir);
      const completedEvent = snapshot.events.find((event) =>
        event.sessionId === session.id && event.name === "session.compaction.completed"
      );
      expect(completedEvent?.data).toMatchObject({
        fileLedger: expect.arrayContaining([
          expect.objectContaining({
            path: "tests/manual-compaction-usage.test.ts",
            latestStatus: "failed",
            failure: "FAIL tests/manual-compaction-usage.test.ts: compaction metadata fixture",
          }),
        ]),
        metrics: expect.objectContaining({
          fileLedgerEntries: expect.any(Number),
        }),
      });
    } finally {
      await server.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  }, 10_000);

  test("records manual local BYOK compaction usage through Z.ai GLM", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "openpond-manual-byok-compaction-"));
    const session = sessionFixture("session_manual_byok_compaction", {
      provider: "zai",
      modelId: "zai/glm-5.2",
    });
    const store = new SqliteStore(storeDir);
    await store.mutate((data) => {
      data.sessions.push(session);
      data.events.push(...compactionEvents(session.id));
    });
    await store.close();
    await writeZaiProviderFiles(storeDir, { contextWindow: 2000 });

    const requests: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      if (!String(input).startsWith("https://provider.example/")) return originalFetch(input, init);
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return streamResponse([
        'data: {"choices":[{"delta":{"content":"BYOK compacted summary."},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":55,"completion_tokens":7,"total_tokens":62}}\n\n',
        "data: [DONE]\n\n",
      ]);
    };

    const server = await createOpenPondServer({
      port: 0,
      storeDir,
      silent: true,
      version: "manual-byok-compaction-usage-test",
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
          body: JSON.stringify({ reason: "manual" }),
        },
      );
      expect(compacted).toMatchObject({
        ok: true,
        mode: "summary",
      });
      expect(compacted.summaryEventId).not.toBeNull();

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        url: "https://provider.example/v1/chat/completions",
        authorization: "Bearer sk-test",
      });
      expect(requests[0]?.body).toMatchObject({
        model: "zai/glm-5.2",
        stream: true,
      });
      expect(requests[0]?.body.tools).toBeUndefined();

      const usage = await api<UsageRecordsResponse>(
        server.url,
        server.token,
        "/v1/usage/records?range=all&limit=10",
      );
      expect(usage.records).toHaveLength(1);
      expect(usage.records[0]).toMatchObject({
        sessionId: session.id,
        turnId: null,
        provider: "zai",
        model: "zai/glm-5.2",
        route: "local_byok",
        source: "provider_usage",
        requestKind: "context_compaction",
        visibility: "background",
        status: "completed",
        promptTokens: 55,
        completionTokens: 7,
        totalTokens: 62,
      });
    } finally {
      await server.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  }, 10_000);

  test("rejects manual BYOK compaction without trusted model context metadata", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "openpond-manual-byok-compaction-no-limit-"));
    const session = sessionFixture("session_manual_byok_no_limit", {
      provider: "zai",
      modelId: "zai/glm-5.2",
    });
    const store = new SqliteStore(storeDir);
    await store.mutate((data) => {
      data.sessions.push(session);
      data.events.push(...compactionEvents(session.id));
    });
    await store.close();
    await writeZaiProviderFiles(storeDir, { contextWindow: null });

    let fetchCalled = false;
    globalThis.fetch = async (input, init) => {
      if (!String(input).startsWith("https://provider.example/")) return originalFetch(input, init);
      fetchCalled = true;
      throw new Error("BYOK provider should not be called without a trusted context window.");
    };

    const server = await createOpenPondServer({
      port: 0,
      storeDir,
      silent: true,
      version: "manual-byok-compaction-no-limit-test",
    });

    try {
      await expect(
        api(server.url, server.token, `/v1/sessions/${encodeURIComponent(session.id)}/compact`, {
          method: "POST",
          body: JSON.stringify({ reason: "manual" }),
        }),
      ).rejects.toThrow("trusted context window");
      expect(fetchCalled).toBe(false);

      const snapshot = await serverSnapshot(storeDir);
      const compactionEvents = snapshot.events.filter((event) => event.name.startsWith("session.compaction."));
      expect(compactionEvents.map((event) => event.name)).toEqual([
        "session.compaction.started",
        "session.compaction.failed",
      ]);
    } finally {
      await server.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  }, 10_000);
});

function sessionFixture(
  id: string,
  options: { provider?: "openpond" | "zai"; modelId?: string } = {},
): Session {
  const provider = options.provider ?? "openpond";
  const modelId = options.modelId ?? "openpond-chat";
  return {
    id,
    provider,
    modelRef: { providerId: provider, modelId },
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

async function writeZaiProviderFiles(storeDir: string, input: { contextWindow: number | null }): Promise<void> {
  process.env.OPENPOND_TEST_ZAI_KEY = "sk-test";
  const model =
    input.contextWindow === null
      ? []
      : [
          {
            id: "zai/glm-5.2",
            providerId: "zai",
            displayName: "GLM 5.2",
            contextWindow: input.contextWindow,
            outputLimit: 1000,
            source: "manual",
          },
        ];
  await writeFile(
    join(storeDir, "providers.json"),
    `${JSON.stringify({
      version: 1,
      providers: {
        zai: {
          enabled: true,
          baseUrl: "https://provider.example/v1",
          defaultModel: "zai/glm-5.2",
          modelOverrides: [],
          updatedAt: "2026-07-04T12:00:00.000Z",
        },
      },
      modelCaches: {
        zai: {
          providerId: "zai",
          models: model,
          fetchedAt: "2026-07-04T12:00:00.000Z",
          lastError: null,
          source: input.contextWindow === null ? "none" : "manual",
        },
      },
    }, null, 2)}\n`,
  );
  await writeFile(
    join(storeDir, "provider-secrets.json"),
    `${JSON.stringify({
      version: 1,
      providers: {
        zai: {
          source: "env",
          envVar: "OPENPOND_TEST_ZAI_KEY",
          createdAt: "2026-07-04T12:00:00.000Z",
          updatedAt: "2026-07-04T12:00:00.000Z",
        },
      },
    }, null, 2)}\n`,
  );
}

async function serverSnapshot(storeDir: string): Promise<{ events: RuntimeEvent[] }> {
  const store = new SqliteStore(storeDir);
  try {
    return await store.snapshot();
  } finally {
    await store.close();
  }
}

function streamResponse(chunks: string[]): Response {
  return new Response(chunks.join(""), {
    headers: { "content-type": "text/event-stream" },
  });
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
      id: "manual_prior_turn_1_failure",
      sessionId,
      turnId: "manual_prior_turn_1",
      name: "command.output",
      timestamp: "2026-07-04T12:01:02.000Z",
      source: "server",
      action: "bun test tests/manual-compaction-usage.test.ts",
      status: "failed",
      output: "FAIL tests/manual-compaction-usage.test.ts: compaction metadata fixture",
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
