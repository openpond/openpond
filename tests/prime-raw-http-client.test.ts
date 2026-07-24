import {
  PrimeComputeTargetAdapter,
  PrimeRawComputeHttpClient,
} from "../packages/compute-provider-prime/src/index.js";
import { runComputeAdapterConformance } from "@openpond/training-sdk";
import { describe, expect, test, vi } from "vitest";

const NOW = new Date("2026-07-24T12:00:00.000Z");

describe("Prime raw compute HTTP client", () => {
  test("discovers, quotes, provisions, verifies, heartbeats, and terminates one SSH node", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const request = vi.fn(async (input: string | URL | Request, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/availability/gpus?")) {
        return json({
          items: [
            {
              cloudId: "gpu_1x_h100_sxm5",
              gpuType: "H100_80GB",
              socket: "SXM5",
              provider: "lambdalabs",
              region: "us-south-2",
              dataCenter: null,
              country: "US",
              gpuCount: 1,
              gpuMemory: 80,
              stockStatus: "Available",
              security: "secure_cloud",
              disk: {
                pricePerUnit: 0.0001,
                defaultIncludedInPrice: false,
              },
              prices: { onDemand: 4.29, isVariable: false },
              prepaidTime: null,
            },
          ],
          totalCount: 1,
        });
      }
      if (url.endsWith("/api/v1/pods/?offset=0&limit=100")) {
        return json({ data: [], total_count: 0, offset: 0, limit: 100 });
      }
      if (
        url.endsWith("/api/v1/pods/") &&
        init.method === "POST"
      ) {
        return json(pod("PENDING", null), 201);
      }
      if (
        url.endsWith("/api/v1/pods/prime-node-1") &&
        init.method === "DELETE"
      ) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/api/v1/pods/prime-node-1")) {
        return json(
          pod("RUNNING", "ssh openpond@gpu.example.test -p 22022"),
        );
      }
      return json({ error: "unexpected request" }, 404);
    });
    const client = new PrimeRawComputeHttpClient({
      apiKey: () => "prime-secret",
      sshKeyId: "ssh-key-1",
      workerTemplateId: "immutable-template-1",
      request: request as typeof fetch,
      now: () => new Date(NOW),
      verifySshHostKey: vi.fn(async () => "SHA256:ZmFrZS1maW5nZXJwcmludA"),
    });
    const adapter = new PrimeComputeTargetAdapter(client);
    const result = await runComputeAdapterConformance({
      adapter,
      request: {
        runId: "prime-run-1",
        deviceOrPool: "gpu_1x_h100_sxm5",
        workerImageDigest: `sha256:${"a".repeat(64)}`,
        maximumSpendUsd: 5,
        deadline: "2026-07-24T13:00:00.000Z",
      },
    });

    expect(result.passed).toBe(true);
    const create = calls.find(
      (call) =>
        call.url.endsWith("/api/v1/pods/") &&
        call.init.method === "POST",
    );
    expect(JSON.parse(String(create?.init.body))).toMatchObject({
      pod: {
        cloudId: "gpu_1x_h100_sxm5",
        customTemplateId: "immutable-template-1",
        sshKeyId: "ssh-key-1",
        maxPrice: 4.29,
        envVars: [],
      },
    });
    expect(
      calls.every(
        (call) =>
          (call.init.headers as Record<string, string>).authorization ===
          "Bearer prime-secret",
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.url.endsWith("/api/v1/pods/prime-node-1") &&
          call.init.method === "DELETE",
      ),
    ).toBe(true);
  });

  test("fails closed before provisioning when the quote exceeds approval", async () => {
    const request = vi.fn(async () =>
      json({
        items: [
          {
            cloudId: "expensive-h100",
            gpuType: "H100_80GB",
            socket: "SXM5",
            provider: "provider",
            region: "region",
            dataCenter: null,
            country: "US",
            gpuCount: 1,
            gpuMemory: 80,
            stockStatus: "Available",
            security: "secure_cloud",
            prices: { onDemand: 10 },
          },
        ],
        totalCount: 1,
      }),
    );
    const adapter = new PrimeComputeTargetAdapter(
      new PrimeRawComputeHttpClient({
        apiKey: () => "prime-secret",
        sshKeyId: "ssh-key-1",
        workerTemplateId: "immutable-template-1",
        request: request as typeof fetch,
        now: () => new Date(NOW),
        verifySshHostKey: async () => "SHA256:ZmFrZQ",
      }),
    );

    await expect(
      adapter.acquire({
        runId: "prime-run-over-cap",
        deviceOrPool: "expensive-h100",
        workerImageDigest: null,
        maximumSpendUsd: 1,
        deadline: "2026-07-24T13:00:00.000Z",
      }),
    ).rejects.toThrow("exceeds the approved maximum");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

function pod(status: string, sshConnection: string | null) {
  return {
    id: "prime-node-1",
    name: "openpond-node",
    status,
    sshConnection,
    installationFailure: null,
    createdAt: NOW.toISOString(),
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
