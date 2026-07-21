import { describe, expect, test, vi } from "vitest";
import {
  createManagedAdapterRegistryClient,
  MANAGED_QWEN3_8B_BASE_PROFILE_ID,
} from "./managed-adapter-registry-client.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("managed adapter registry client", () => {
  test("uploads desktop Fireworks bytes as a user-scoped direct import", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/v1/model-adapters/uploads")) {
        return Response.json({
          upload: { id: "upload-1", version: 1, state: "uploading" },
          uploadCapabilities: [
            {
              path: "adapter_config.json",
              url: "https://openpond-test.s3.us-east-2.amazonaws.com/config",
              headers: { "content-type": "application/json" },
            },
            {
              path: "adapter_model.safetensors",
              url: "https://openpond-test.s3.us-east-2.amazonaws.com/weights",
              headers: {
                "content-type": "application/vnd.safetensors",
              },
            },
          ],
        });
      }
      if (
        url.startsWith(
          "https://openpond-test.s3.us-east-2.amazonaws.com/",
        )
      ) {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/v1/model-adapters/uploads/upload-1/complete")) {
        return Response.json({
          artifact: {
            id: "artifact-1",
            source: "direct_upload",
            sourceRef: "upload:upload-1",
            state: "imported_unvalidated",
            promotable: false,
            customerBindingAllowed: false,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = createManagedAdapterRegistryClient({
      fetchImpl: fetchImpl as typeof fetch,
      readFileImpl: (async (path: string) =>
        path.endsWith("config")
          ? Buffer.from("{}")
          : Buffer.from([1, 2, 3])) as never,
      resolveRegistryAccess: async (teamId) => ({
        apiBaseUrl: "https://api.test",
        token: "opk_user",
        teamId,
      }),
      resolveTrustedSourceAccess: vi.fn(async () => {
        throw new Error(
          "trusted source identity must not run in the desktop",
        );
      }),
      resolveInferenceAccess: vi.fn(async () => {
        throw new Error("inference identity must not publish artifacts");
      }),
    });
    const artifact = await client.publishFireworksSource(sourceImport());
    expect(artifact.id).toBe("artifact-1");
    const create = requests.find((request) =>
      request.url.endsWith("/uploads"),
    );
    const body = JSON.parse(String(create?.init.body)) as Record<string, unknown>;
    expect(body.baseProfileId).toBe(MANAGED_QWEN3_8B_BASE_PROFILE_ID);
    expect(body).not.toHaveProperty("teamId");
    expect(body).not.toHaveProperty("token");
    expect(body).not.toHaveProperty("source");
    expect(body).not.toHaveProperty("sourceProvenance");
    expect(new Headers(create?.init.headers).get("openpond-api-key")).toBe(
      "opk_user",
    );
    expect(
      new Headers(create?.init.headers).get("x-openpond-team-id"),
    ).toBe("team_qa");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  test("reserves trusted Fireworks provenance for the hosted service identity", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/v1/model-adapters/source-imports")) {
        return Response.json({
          upload: {
            id: "upload-trusted",
            version: 1,
            state: "uploading",
          },
          uploadCapabilities: uploadCapabilities(),
        });
      }
      if (
        url.startsWith(
          "https://openpond-test.s3.us-east-2.amazonaws.com/",
        )
      ) {
        return new Response(null, { status: 200 });
      }
      if (
        url.endsWith(
          "/v1/model-adapters/uploads/upload-trusted/complete",
        )
      ) {
        return Response.json({
          artifact: {
            id: "artifact-trusted",
            source: "openpond_fireworks",
            sourceRef: "lineage-1",
            state: "imported_unvalidated",
            promotable: false,
            customerBindingAllowed: false,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = createManagedAdapterRegistryClient({
      fetchImpl: fetchImpl as typeof fetch,
      readFileImpl: artifactReader,
      resolveRegistryAccess: vi.fn(async () => {
        throw new Error("user identity must not assert trusted provenance");
      }),
      resolveTrustedSourceAccess: async () => ({
        apiBaseUrl: "https://api.test",
        token: "opk_service",
        teamId: "team_qa",
      }),
    });

    const artifact = await client.publishTrustedFireworksSource(
      sourceImport(),
    );

    expect(artifact).toMatchObject({
      id: "artifact-trusted",
      source: "openpond_fireworks",
    });
    const create = requests.find((request) =>
      request.url.endsWith("/source-imports"),
    );
    const body = JSON.parse(String(create?.init.body)) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      source: "openpond_fireworks",
      sourceRef: "lineage-1",
      sourceProvenance: expect.objectContaining({
        sourceSystem: "openpond_fireworks",
        trainingJobId: "job-1",
      }),
    });
    expect(new Headers(create?.init.headers).get("openpond-api-key")).toBe(
      "opk_service",
    );
    expect(
      new Headers(create?.init.headers).get("x-openpond-team-id"),
    ).toBe("team_qa");
  });

  test("uses the explicit user workspace for registry reads and binding sync", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.includes("/artifacts?")) {
          return Response.json({ artifacts: [] });
        }
        if (url.endsWith("/deployments")) {
          return Response.json({ deployments: [] });
        }
        if (url.endsWith("/binding-projections")) {
          return Response.json({});
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    const client = createManagedAdapterRegistryClient({
      fetchImpl: fetchImpl as typeof fetch,
      resolveRegistryAccess: async (teamId) => ({
        apiBaseUrl: "https://api.test",
        token: "opk_user",
        teamId,
      }),
      resolveTrustedSourceAccess: vi.fn(async () => {
        throw new Error("trusted identity must not list or bind");
      }),
    });

    await client.listRegistry("team_customer");
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
      fetchImpl: fetchImpl as typeof fetch,
      resolveRegistryAccess: async () => ({
        apiBaseUrl: "https://api.test",
        token: "opk_user",
        teamId: "team_other",
      }),
    });

    await expect(client.listRegistry("team_customer")).rejects.toThrow(
      "different OpenPond team",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("resumes a committed idempotent import without re-uploading bytes", async () => {
    const readFileImpl = vi.fn(artifactReader);
    const fetchImpl = vi.fn(
      async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/v1/model-adapters/uploads")) {
          return Response.json({
            upload: {
              id: "upload-replayed",
              version: 3,
              state: "committed",
            },
            uploadCapabilities: [],
          });
        }
        if (
          url.endsWith(
            "/v1/model-adapters/uploads/upload-replayed/complete",
          )
        ) {
          return Response.json({
            artifact: {
              id: "artifact-replayed",
              source: "direct_upload",
              sourceRef: "upload:upload-replayed",
              state: "imported_unvalidated",
              promotable: false,
              customerBindingAllowed: false,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    const client = createManagedAdapterRegistryClient({
      fetchImpl: fetchImpl as typeof fetch,
      readFileImpl: readFileImpl as never,
      resolveRegistryAccess: async () => ({
        apiBaseUrl: "https://api.test",
        token: "opk_user",
        teamId: "team_qa",
      }),
    });

    await expect(
      client.publishFireworksSource(sourceImport()),
    ).resolves.toMatchObject({ id: "artifact-replayed" });
    expect(readFileImpl).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("translates managed OpenAI SSE and preserves request cancellation", async () => {
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
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      observedInit = init;
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const client = createManagedAdapterRegistryClient({
      fetchImpl: fetchImpl as typeof fetch,
      resolveRegistryAccess: vi.fn(async () => {
        throw new Error("service identity must not run customer inference");
      }),
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
      expect.objectContaining({
        usage: { prompt_tokens: 4, completion_tokens: 1 },
      }),
      expect.objectContaining({ finishReason: "stop" }),
    ]);
    const headers = new Headers(observedInit?.headers);
    expect(headers.get("idempotency-key")).toBe("request-1");
    expect(headers.get("openpond-api-key")).toBe("opk_user");
    expect(headers.get("x-openpond-team-id")).toBe("team_customer");
  });
});

function trainingArtifact(id: string, sha256: string, sizeBytes: number) {
  return {
    schemaVersion: "openpond.trainingArtifact.v1" as const,
    id,
    jobId: "job-1",
    kind: "adapter" as const,
    path: `/tmp/${id}`,
    sha256,
    sizeBytes,
    baseModelId: "Qwen/Qwen3-8B",
    baseModelRevision: "b968826d9c46dd6066d109eabc6255188de91218",
    tokenizerRevision: "main",
    chatTemplateHash: "c".repeat(64),
    nonProduction: false,
    createdAt: "2026-07-19T12:00:00.000Z",
    metadata: { provider: "fireworks", providerFilename: id },
  };
}

function uploadCapabilities() {
  return [
    {
      path: "adapter_config.json",
      url: "https://openpond-test.s3.us-east-2.amazonaws.com/config",
      headers: { "content-type": "application/json" },
    },
    {
      path: "adapter_model.safetensors",
      url: "https://openpond-test.s3.us-east-2.amazonaws.com/weights",
      headers: {
        "content-type": "application/vnd.safetensors",
      },
    },
  ];
}

const artifactReader = (async (path: string) =>
  path.endsWith("config")
    ? Buffer.from("{}")
    : Buffer.from([1, 2, 3])) as never;

function sourceImport() {
  return {
    teamId: "team_qa",
    lineageId: "lineage-1",
    label: "GRPO adapter",
    trainingJobId: "job-1",
    trainingPlanId: "plan-1",
    sourceArtifactId: "source-artifact-1",
    sourceArtifactSha256: SHA_B,
    tasksetId: "taskset-1",
    tasksetHash: SHA_A,
    evaluationArtifactId: null,
    evaluationArtifactSha256: null,
    providerRunId: "provider-run-1",
    files: [
      {
        artifact: trainingArtifact("config", SHA_A, 2),
        path: "adapter_config.json",
        mediaType: "application/json" as const,
      },
      {
        artifact: trainingArtifact("weights", SHA_B, 3),
        path: "adapter_model.safetensors",
        mediaType: "application/vnd.safetensors" as const,
      },
    ],
  };
}
