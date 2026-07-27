import { describe, expect, test, vi } from "vitest";
import { createManagedAdapterRegistryClient } from "./managed-adapter-registry-client.js";

const MANAGED_QWEN3_0_6B_BASE_PROFILE_ID = "qwen3-0-6b-c1899de2";
const MANAGED_QWEN3_8B_BASE_PROFILE_ID = "qwen3-8b-b968826d";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("managed adapter registry client", () => {
  test("reads Sandbox-owned versioned base-profile capabilities", async () => {
    const client = createManagedAdapterRegistryClient({
      fetchImpl: vi.fn(async () =>
        Response.json({
          schemaVersion: "openpond.modelAdapterPlatformCapabilities.v1",
          contractVersions: {
            baseModelProfile: "openpond.baseModelProfile.v2",
          },
          baseProfiles: [
            {
              id: MANAGED_QWEN3_8B_BASE_PROFILE_ID,
              repository: "Qwen/Qwen3-8B",
              revision: "b968826d9c46dd6066d109eabc6255188de91218",
              tokenizerRevision: "b968826d9c46dd6066d109eabc6255188de91218",
              chatTemplateHash: "a".repeat(64),
              status: "qualified",
            },
          ],
          lifecycle: { policyOwner: "sandbox" },
        })
      ) as typeof fetch,
      resolveRegistryAccess: async (teamId) => ({
        apiBaseUrl: "https://api.test",
        token: "opk_user",
        teamId,
      }),
    });

    await expect(client.capabilities("team_qa")).resolves.toMatchObject({
      baseModelProfileContractVersion: "openpond.baseModelProfile.v2",
      lifecyclePolicyOwner: "sandbox",
      baseProfiles: [
        {
          id: MANAGED_QWEN3_8B_BASE_PROFILE_ID,
          status: "qualified",
        },
      ],
    });
  });

  test("uploads desktop Fireworks bytes as a user-scoped direct import", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init = {}) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith("/v1/model-adapters/uploads")) {
          return Response.json({
            upload: { id: "upload-1", version: 1, state: "uploading" },
            uploadCapabilities: [
              {
                path: "adapter_config.json",
                url: "https://f82ac02df53f47472f99ef52b737795d.r2.cloudflarestorage.com/config",
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
          url.startsWith("https://openpond-test.s3.us-east-2.amazonaws.com/") ||
          url.startsWith(
            "https://f82ac02df53f47472f99ef52b737795d.r2.cloudflarestorage.com/"
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
      }
    );
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
        throw new Error("trusted source identity must not run in the desktop");
      }),
      resolveInferenceAccess: vi.fn(async () => {
        throw new Error("inference identity must not publish artifacts");
      }),
    });
    const artifact = await client.publishFireworksSource(sourceImport());
    expect(artifact.id).toBe("artifact-1");
    const create = requests.find((request) => request.url.endsWith("/uploads"));
    const body = JSON.parse(String(create?.init.body)) as Record<
      string,
      unknown
    >;
    expect(body.baseProfileId).toBe(MANAGED_QWEN3_8B_BASE_PROFILE_ID);
    expect(body).not.toHaveProperty("teamId");
    expect(body).not.toHaveProperty("token");
    expect(body).not.toHaveProperty("source");
    expect(body).not.toHaveProperty("sourceProvenance");
    expect(new Headers(create?.init.headers).get("openpond-api-key")).toBe(
      "opk_user"
    );
    expect(new Headers(create?.init.headers).get("x-openpond-team-id")).toBe(
      "team_qa"
    );
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  test("reserves trusted Fireworks provenance for the hosted service identity", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init = {}) => {
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
          url.startsWith("https://openpond-test.s3.us-east-2.amazonaws.com/")
        ) {
          return new Response(null, { status: 200 });
        }
        if (
          url.endsWith("/v1/model-adapters/uploads/upload-trusted/complete")
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
      }
    );
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

    const artifact = await client.publishTrustedFireworksSource(sourceImport());

    expect(artifact).toMatchObject({
      id: "artifact-trusted",
      source: "openpond_fireworks",
    });
    const create = requests.find((request) =>
      request.url.endsWith("/source-imports")
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
      "opk_service"
    );
    expect(new Headers(create?.init.headers).get("x-openpond-team-id")).toBe(
      "team_qa"
    );
  });

  test("publishes signed Prime GRPO provenance without owning serving lifecycle", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith("/v1/model-adapters/openpond-training-publications")) {
          return Response.json({
            upload: {
              id: "upload-prime",
              version: 1,
              state: "uploading",
            },
            uploadCapabilities: uploadCapabilities(),
          });
        }
        if (
          url.startsWith("https://openpond-test.s3.us-east-2.amazonaws.com/")
        ) {
          return new Response(null, { status: 200 });
        }
        if (url.endsWith("/v1/model-adapters/uploads/upload-prime/complete")) {
          return Response.json({
            artifact: {
              id: "artifact-prime",
              source: "openpond_training",
              sourceRef: "lineage-1",
              state: "imported_unvalidated",
              promotable: false,
              customerBindingAllowed: false,
            },
          });
        }
        if (url.endsWith("/artifact-prime/evaluations")) {
          return Response.json({
            evaluation: {
              id: "evaluation-prime",
              state: "queued",
            },
          });
        }
        if (url.endsWith("/artifact-prime/deploy")) {
          return Response.json({
            deployment: {
              id: "deployment-prime",
              artifactId: "artifact-prime",
              state: "requested",
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    const client = createManagedAdapterRegistryClient({
      fetchImpl: fetchImpl as typeof fetch,
      readFileImpl: artifactReader,
      resolveTrustedSourceAccess: async (teamId) => ({
        apiBaseUrl: "https://api.test",
        token: "opk_service",
        teamId,
      }),
      resolveRegistryAccess: async (teamId) => ({
        apiBaseUrl: "https://api.test",
        token: "opk_user",
        teamId,
      }),
    });

    await client.publishTrustedOpenPondTrainingSource(
      openPondTrainingSourceImport()
    );

    const create = requests.find((request) =>
      request.url.endsWith("/openpond-training-publications")
    );
    const body = JSON.parse(String(create?.init.body));
    expect(body).toMatchObject({
      source: "openpond_training",
      sourceRef: "lineage-1",
      baseProfileId: MANAGED_QWEN3_0_6B_BASE_PROFILE_ID,
      idempotencyKey: `openpond-training:v5:lineage-1:${"1".repeat(64)}`,
      sourceProvenance: {
        sourceSystem: "openpond_training",
        modelRunId: "model-run-1",
      },
    });
    const publicationHeaders = new Headers(create?.init.headers);
    expect(publicationHeaders.get("openpond-api-key")).toBe("opk_service");
    expect(
      requests.some(
        (request) =>
          request.url.endsWith("/evaluations") ||
          request.url.endsWith("/deploy")
      )
    ).toBe(false);
  });

  test("uses the explicit user workspace for registry reads and binding sync", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.includes("/artifacts?")) {
          return Response.json({
            artifacts: [
              {
                id: "artifact-1",
                source: "openpond_training",
                sourceRef: "lineage-1",
                state: "promotable",
                promotable: true,
                customerBindingAllowed: true,
                contentHash: "1".repeat(64),
                baseProfileId: MANAGED_QWEN3_0_6B_BASE_PROFILE_ID,
              },
            ],
          });
        }
        if (url.endsWith("/deployments")) {
          return Response.json({
            deployments: [
              {
                id: "deployment-1",
                artifactId: "artifact-1",
                state: "failed",
              },
            ],
          });
        }
        if (url.endsWith("/binding-projections")) {
          return Response.json({});
        }
        throw new Error(`Unexpected request: ${url}`);
      }
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

    expect(requests).toHaveLength(3);
    expect(registry).toMatchObject({
      artifacts: [
        {
          id: "artifact-1",
          contentHash: "1".repeat(64),
          customerBindingAllowed: true,
        },
      ],
      deployments: [
        {
          id: "deployment-1",
          state: "failed",
        },
      ],
    });
    expect(registry).not.toHaveProperty("servingPools");
    expect(registry).not.toHaveProperty("servingReceipts");
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
      "different OpenPond team"
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("resumes a committed idempotent import without re-uploading bytes", async () => {
    const readFileImpl = vi.fn(artifactReader);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
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
      if (url.endsWith("/v1/model-adapters/uploads/upload-replayed/complete")) {
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
    });
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
      client.publishFireworksSource(sourceImport())
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
              "data: [DONE]\n\n"
          )
        );
        controller.close();
      },
    });
    let observedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        observedInit = init;
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
    );
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
    baseProfileId: MANAGED_QWEN3_8B_BASE_PROFILE_ID,
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

function openPondTrainingSourceImport() {
  const hash = (character: string) => character.repeat(64);
  return {
    teamId: "team_qa",
    lineageId: "lineage-1",
    label: "Prime GRPO adapter",
    baseProfileId: MANAGED_QWEN3_0_6B_BASE_PROFILE_ID,
    files: sourceImport().files,
    provenance: {
      schemaVersion: "openpond.modelAdapterSourceProvenance.v1" as const,
      sourceSystem: "openpond_training" as const,
      trainingJobId: "job-1",
      trainingPlanId: "plan-1",
      sourceArtifactId: "artifact-1",
      sourceArtifactSha256: hash("1"),
      sourceManifestSha256: hash("2"),
      sourceInventorySha256: hash("3"),
      sourceBaseModelSha256: hash("4"),
      candidateBundleSha256: hash("5"),
      tasksetId: "taskset-1",
      tasksetHash: hash("6"),
      evaluationArtifactId: "evaluation-1",
      evaluationArtifactSha256: hash("7"),
      frozenEvaluatorHash: hash("8"),
      spendAttestationSha256: hash("9"),
      cleanupAttestationSha256: hash("a"),
      providerRunId: "prime-run-1",
      trainingMethod: "grpo" as const,
      sourcePolicyOrCheckpoint: "model-version-1:policy-1",
      optimizerProofSha256: hash("b"),
      modelProjectId: "model-1",
      modelRunId: "model-run-1",
      modelVersionId: "model-version-1",
      primeRlRevision: "c".repeat(40),
      rawPrimeComputeReceiptSha256: hash("d"),
      harnessReleaseSha256: hash("e"),
      profileReleaseSha256: hash("f"),
      agentReleaseSha256: hash("0"),
      graderSha256: hash("1"),
      trainingTelemetrySha256: hash("2"),
    },
  };
}
