import { describe, expect, test, vi } from "vitest";
import type { FireworksModelServingSession } from "../packages/contracts/src";
import { createFireworksServingService } from "../apps/server/src/training/fireworks-serving-service";

describe("bounded Fireworks model serving", () => {
  test("validates one H100, attaches the LoRA, chats, and tears everything down", async () => {
    const sessions = new Map<string, FireworksModelServingSession>();
    const calls: Array<{ method: string; url: string }> = [];
    let now = new Date("2026-07-17T20:00:00.000Z");
    const request = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      if (url.endsWith("/v1/accounts")) {
        return json({ accounts: [{ name: "accounts/test-account" }] });
      }
      if (url.includes("/deployments?") && method === "POST") {
        return json({
          name: "accounts/test-account/deployments/op-use-test",
          state: "READY",
          acceleratorCount: 1,
          minReplicaCount: 1,
          maxReplicaCount: 1,
          enableHotReloadLatestAddon: true,
        });
      }
      if (url.includes("/deployments/") && method === "GET") {
        return json({
          state: "READY",
          acceleratorCount: 1,
          minReplicaCount: 1,
          maxReplicaCount: 1,
          enableHotReloadLatestAddon: true,
        });
      }
      if (url.includes("/deployedModels?") && method === "POST") {
        return json({
          name: "accounts/test-account/deployedModels/chat-lora",
          state: "DEPLOYED",
        });
      }
      if (url.endsWith("/deployedModels/chat-lora") && method === "GET") {
        return json({ state: "DEPLOYED" });
      }
      if (url.endsWith("/chat/completions") && method === "POST") {
        return json({
          choices: [{ message: { content: "Billing and support are reconciled." } }],
          usage: { prompt_tokens: 12, completion_tokens: 7 },
        });
      }
      if (
        (url.endsWith("/deployedModels/chat-lora")
          || url.includes("/deployments/"))
        && method === "DELETE"
      ) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected Fireworks request ${method} ${url}`);
    });
    const store = {
      getModelArtifactLineage: async (id: string) => id === "model-1"
        ? {
            id: "model-1",
            status: "imported",
            jobId: "job-1",
            tasksetId: "taskset-1",
          }
        : null,
      getTrainingJob: async (id: string) => id === "job-1"
        ? {
            id: "job-1",
            status: "succeeded",
            destinationId: "fireworks",
            metadata: {
              provider: "fireworks",
              outputModelName: "accounts/test-account/models/crm-lora",
              baseModel: "accounts/fireworks/models/llama-v3p1-8b-instruct",
            },
          }
        : null,
      getTaskset: async (id: string) => id === "taskset-1"
        ? { id: "taskset-1", profileId: "0xglu" }
        : null,
      listFireworksModelServingSessions: async (input: {
        profileId?: string;
        modelArtifactLineageId?: string;
      } = {}) => [...sessions.values()].filter((session) =>
        (!input.profileId || session.profileId === input.profileId)
        && (
          !input.modelArtifactLineageId
          || session.modelArtifactLineageId === input.modelArtifactLineageId
        )),
      getFireworksModelServingSession: async (id: string) =>
        sessions.get(id) ?? null,
      saveFireworksModelServingSession: async (
        session: FireworksModelServingSession,
      ) => {
        sessions.set(session.id, session);
        return session;
      },
      getActiveModelBinding: async () => null,
    };
    const service = createFireworksServingService({
      store: store as never,
      resolveCredential: async () => ({ value: "fw_test_secret" }),
      request: request as typeof fetch,
      now: () => now,
      setTimer: (() => ({ unref() {} })) as never,
      clearTimer: (() => undefined) as never,
    });

    const starting = await service.start({
      profileId: "0xglu",
      modelId: "model-1",
    });
    expect(starting.state).toBe("starting");
    const ready = await waitForSession(sessions, starting.id, "ready");
    expect(ready).toMatchObject({
      acceleratorCount: 1,
      acceleratorType: "NVIDIA_H100_80GB",
      maxDurationSeconds: 600,
      idleTimeoutSeconds: 300,
      maxEstimatedCostUsd: 1.17,
      deployedModelId: "chat-lora",
    });

    now = new Date("2026-07-17T20:01:00.000Z");
    const deltas = [];
    for await (const delta of service.stream({
      modelId: "model-1",
      messages: [{ role: "user", content: "Reconcile the account." }],
      requestId: "request-1",
      signal: new AbortController().signal,
    })) {
      deltas.push(delta);
    }
    expect(deltas).toContainEqual(expect.objectContaining({
      text: "Billing and support are reconciled.",
    }));

    const stopped = await service.stop(starting.id, "user");
    expect(stopped.state).toBe("stopped");
    expect(stopped.estimatedCostUsd).toBeCloseTo(0.116667, 6);
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "DELETE", url: expect.stringContaining("/deployedModels/chat-lora") }),
      expect.objectContaining({ method: "DELETE", url: expect.stringContaining("/deployments/") }),
    ]));
  });
});

async function waitForSession(
  sessions: Map<string, FireworksModelServingSession>,
  id: string,
  state: FireworksModelServingSession["state"],
): Promise<FireworksModelServingSession> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const session = sessions.get(id);
    if (session?.state === state) return session;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(
    `Serving session ${id} did not enter ${state}: ${JSON.stringify(sessions.get(id))}`,
  );
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
