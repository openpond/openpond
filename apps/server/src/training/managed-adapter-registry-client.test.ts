import { describe, expect, test, vi } from "vitest";
import { createManagedAdapterRegistryClient } from "./managed-adapter-registry-client.js";

describe("managed adapter registry client", () => {
  test("reads Sandbox-owned versioned base-profile capabilities", async () => {
    const client = createManagedAdapterRegistryClient({
      fetchImpl: vi.fn(async () =>
        Response.json({
          schemaVersion: "openpond.modelAdapterPlatformCapabilities.v1",
          contractVersions: { baseModelProfile: "openpond.baseModelProfile.v2" },
          baseProfiles: [
            {
              id: "qwen3-0-6b-c1899de2",
              repository: "Qwen/Qwen3-0.6B",
              revision: "c1899de289a04d12100db370d81485cdf75e47ca",
              tokenizerRevision: "c1899de289a04d12100db370d81485cdf75e47ca",
              chatTemplateHash: "a".repeat(64),
              status: "supported",
            },
          ],
          lifecycle: { policyOwner: "sandbox" },
        }),
      ) as unknown as typeof fetch,
      resolveRegistryAccess: async (teamId) => ({
        apiBaseUrl: "https://api.test",
        token: "opk_user",
        teamId,
      }),
    });

    await expect(client.capabilities("team_qa")).resolves.toMatchObject({
      lifecyclePolicyOwner: "sandbox",
      baseProfiles: [{ id: "qwen3-0-6b-c1899de2", status: "supported" }],
    });
  });

  test("uses the explicit user workspace for registry reads and binding sync", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("/artifacts?")) {
        return Response.json({
          artifacts: [
            {
              id: "artifact-1",
              source: "sandbox_managed_rl",
              sourceRef: "r2://managed-rl/jobs/managed-job-1/candidate.json",
              state: "promotable",
              promotable: true,
              customerBindingAllowed: true,
              contentHash: "1".repeat(64),
              baseProfileId: "qwen3-0-6b-c1899de2",
            },
          ],
        });
      }
      if (url.endsWith("/deployments")) {
        return Response.json({
          deployments: [{ id: "deployment-1", artifactId: "artifact-1", state: "ready" }],
        });
      }
      if (url.endsWith("/binding-projections")) return Response.json({});
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = createManagedAdapterRegistryClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveRegistryAccess: async (teamId) => ({
        apiBaseUrl: "https://api.openpond.ai",
        token: "opk_user",
        teamId,
      }),
    });

    const registry = await client.listRegistry("team_customer");
    await client.syncBinding({
      teamId: "team_customer",
      binding: {
        id: "binding-1",
        modelArtifactLineageId: "lineage-1",
        role: "chat_manual",
      } as never,
      logicalModelName: "trained-model",
      artifactId: "artifact-1",
      deploymentId: "deployment-1",
      bindingVersion: 1,
      sourceUpdatedAt: "2026-07-20T00:00:00.000Z",
      state: "active",
    });

    expect(registry.artifacts[0]).toMatchObject({ id: "artifact-1", customerBindingAllowed: true });
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      const headers = new Headers(request.init.headers);
      expect(headers.get("openpond-api-key")).toBe("opk_user");
      expect(headers.get("x-openpond-team-id")).toBe("team_customer");
    }
  });

  test("fails before network access when account resolution changes the requested team", async () => {
    const fetchImpl = vi.fn();
    const client = createManagedAdapterRegistryClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveRegistryAccess: async () => ({
        apiBaseUrl: "https://api.test",
        token: "opk_user",
        teamId: "team_other",
      }),
    });

    await expect(client.listRegistry("team_customer")).rejects.toThrow("different OpenPond team");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("translates managed OpenAI SSE and preserves request identity", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n' +
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1}}\n\n' +
              "data: [DONE]\n\n",
          ),
        );
        controller.close();
      },
    });
    let observedInit: RequestInit | undefined;
    const client = createManagedAdapterRegistryClient({
      fetchImpl: vi.fn(async (_input, init) => {
        observedInit = init;
        return new Response(stream, { status: 200 });
      }) as unknown as typeof fetch,
      resolveInferenceAccess: async (teamId) => ({
        apiBaseUrl: "https://api.test",
        token: "opk_user",
        teamId,
      }),
    });
    const deltas = [];
    for await (const delta of client.streamChat({
      teamId: "team_customer",
      logicalModelName: "trained-model",
      messages: [{ role: "user", content: "hi" }],
      requestId: "request-1",
      signal: new AbortController().signal,
    })) {
      deltas.push(delta);
    }

    expect(deltas).toEqual([
      expect.objectContaining({ text: "hello" }),
      expect.objectContaining({ usage: { prompt_tokens: 4, completion_tokens: 1 } }),
      expect.objectContaining({ finishReason: "stop" }),
    ]);
    expect(new Headers(observedInit?.headers).get("idempotency-key")).toBe("request-1");
  });
});
