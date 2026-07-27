import {
  PrimeComputeTargetAdapter,
  PrimeRawComputeHttpClient,
} from "../packages/compute-provider-prime/src/index.js";
import { describe, expect, test, vi } from "vitest";

const NOW = new Date("2026-07-24T12:00:00.000Z");

describe("Prime raw compute HTTP client", () => {
  test("discovers, quotes, provisions, verifies, heartbeats, and terminates one SSH node", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const request = vi.fn(async (input: string | URL | Request, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/v1/billing/wallet?")) {
        return json({
          wallet_id: "wallet-1",
          team_id: null,
          balance_usd: 7.5,
          currency: "USD",
          total_billings: 0,
          recent_billings: [],
        });
      }
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
              images: ["custom_template", "prime_rl"],
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
      if (url.endsWith("/api/v1/pods/") && init.method === "POST") {
        return json(pod("PENDING", null), 201);
      }
      if (
        url.endsWith("/api/v1/pods/prime-node-1") &&
        init.method === "DELETE"
      ) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/api/v1/pods/prime-node-1")) {
        return json(pod("RUNNING", "ssh openpond@gpu.example.test -p 22022"));
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
    const inventory = await adapter.discover();
    const deviceOrPool = inventory.devices[0]!.id;
    const computeRequest = {
      runId: "prime-run-1",
      deviceOrPool,
      workerImageDigest: `sha256:${"a".repeat(64)}`,
      maximumSpendUsd: 5,
      deadline: "2026-07-24T13:00:00.000Z",
    };
    const quote = await adapter.quote(computeRequest);
    const lease = await adapter.acquire(computeRequest);
    const heartbeat = await adapter.heartbeat(lease);
    await adapter.release(heartbeat);
    const reconnected = await client.connect(
      "prime-node-1",
      "2026-07-24T13:00:00.000Z"
    );

    expect(quote.adapterId).toBe(adapter.id);
    expect(lease.adapterId).toBe(adapter.id);
    expect(heartbeat.id).toBe(lease.id);
    expect(reconnected).toMatchObject({
      nodeId: "prime-node-1",
      acquiredAt: NOW.toISOString(),
      host: "gpu.example.test",
      port: 22022,
      user: "openpond",
      sshHostFingerprint: "SHA256:ZmFrZS1maW5nZXJwcmludA",
    });
    const create = calls.find(
      (call) =>
        call.url.endsWith("/api/v1/pods/") && call.init.method === "POST"
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
          "Bearer prime-secret"
      )
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.url.endsWith("/api/v1/pods/prime-node-1") &&
          call.init.method === "DELETE"
      )
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.url.includes("/api/v1/billing/wallet?limit=1&offset=0")
      )
    ).toBe(true);
  });

  test("discovers an explicitly selected lower-memory evaluation GPU tier", async () => {
    let requestedUrl = "";
    const request = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return json({
        items: [
          {
            cloudId: "gpu_1x_a10",
            gpuType: "A10_24GB",
            socket: "PCIe",
            provider: "lambdalabs",
            region: "united_states",
            dataCenter: null,
            country: "US",
            gpuCount: 1,
            gpuMemory: 24,
            stockStatus: "Available",
            security: "secure_cloud",
            images: ["prime_rl"],
            prices: { onDemand: 1.29, isVariable: false },
            prepaidTime: null,
          },
        ],
      });
    });
    const client = new PrimeRawComputeHttpClient({
      apiKey: () => "prime-secret",
      sshKeyId: "ssh-key-1",
      image: "prime_rl",
      gpuType: "A10_24GB",
      request: request as typeof fetch,
      now: () => new Date(NOW),
      verifySshHostKey: async () => "SHA256:ZmFrZQ",
    });

    const inventory = await client.inventory();
    const quote = await client.quote({
      deviceOrPool: inventory.devices[0]!.id,
      deadline: "2026-07-24T13:00:00.000Z",
    });

    expect(requestedUrl).toContain("gpu_type=A10_24GB");
    expect(inventory.devices[0]).toMatchObject({
      name: "A10_24GB · lambdalabs · united_states",
      memoryBytes: 24_000_000_000,
    });
    expect(quote.assumptions).toContain(
      "One secure-cloud A10_24GB (24 GB)",
    );
  });

  test("terminates the exact pod when provisioning is cancelled before SSH readiness", async () => {
    const controller = new AbortController();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const request = vi.fn(async (input: string | URL | Request, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/availability/gpus?")) {
        return json({
          items: [{
            cloudId: "gpu_1x_a10",
            gpuType: "A10_24GB",
            socket: "PCIe",
            provider: "lambdalabs",
            region: "united_states",
            dataCenter: null,
            country: "US",
            gpuCount: 1,
            gpuMemory: 24,
            stockStatus: "Available",
            security: "secure_cloud",
            images: ["prime_rl"],
            prices: { onDemand: 1.29, isVariable: false },
            prepaidTime: null,
          }],
        });
      }
      if (url.endsWith("/api/v1/pods/?offset=0&limit=100")) {
        return json({ data: [] });
      }
      if (url.endsWith("/api/v1/pods/") && init.method === "POST") {
        return json(pod("PENDING", null), 201);
      }
      if (
        url.endsWith("/api/v1/pods/prime-node-1")
        && init.method === "DELETE"
      ) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/api/v1/pods/prime-node-1")) {
        controller.abort(new Error("cancelled benchmark provisioning"));
        return json(pod("PENDING", null));
      }
      return json({}, 404);
    });
    const client = new PrimeRawComputeHttpClient({
      apiKey: () => "prime-secret",
      sshKeyId: "ssh-key-1",
      image: "prime_rl",
      gpuType: "A10_24GB",
      request: request as typeof fetch,
      pollIntervalMs: 1,
      now: () => new Date(NOW),
      verifySshHostKey: async () => "SHA256:ZmFrZQ",
    });
    const inventory = await client.inventory();

    await expect(client.provision({
      deviceOrPool: inventory.devices[0]!.id,
      deadline: "2026-07-24T13:00:00.000Z",
      idempotencyKey: "cancelled-benchmark",
      signal: controller.signal,
    })).rejects.toThrow("cancelled benchmark provisioning");
    expect(calls.some(
      (call) =>
        call.url.endsWith("/api/v1/pods/prime-node-1")
        && call.init.method === "DELETE",
    )).toBe(true);
  });

  test("fails closed before provisioning when the quote exceeds approval", async () => {
    const request = vi.fn(async () =>
      json(
        request.mock.calls.length === 1
          ? {
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
                  images: ["custom_template"],
                  prices: { onDemand: 10 },
                },
              ],
              totalCount: 1,
            }
          : {
              wallet_id: "wallet-1",
              team_id: null,
              balance_usd: 20,
              currency: "USD",
              total_billings: 0,
              recent_billings: [],
            }
      )
    );
    const adapter = new PrimeComputeTargetAdapter(
      new PrimeRawComputeHttpClient({
        apiKey: () => "prime-secret",
        sshKeyId: "ssh-key-1",
        workerTemplateId: "immutable-template-1",
        request: request as typeof fetch,
        now: () => new Date(NOW),
        verifySshHostKey: async () => "SHA256:ZmFrZQ",
      })
    );
    const inventory = await adapter.discover();

    await expect(
      adapter.acquire({
        runId: "prime-run-over-cap",
        deviceOrPool: inventory.devices[0]!.id,
        workerImageDigest: null,
        maximumSpendUsd: 1,
        deadline: "2026-07-24T13:00:00.000Z",
      })
    ).rejects.toThrow("exceeds the approved maximum");
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("uses the live wallet balance when no narrower manual cap is supplied", async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/availability/gpus?")) {
        return json({
          items: [
            {
              cloudId: "wallet-capped-h100",
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
              images: ["prime_rl"],
              prices: { onDemand: 4, isVariable: false },
              prepaidTime: null,
            },
          ],
        });
      }
      if (url.includes("/api/v1/billing/wallet?")) {
        return json({
          wallet_id: "wallet-capped",
          team_id: null,
          balance_usd: 1,
          currency: "USD",
          total_billings: 0,
          recent_billings: [],
        });
      }
      return json({}, 404);
    });
    const adapter = new PrimeComputeTargetAdapter(
      new PrimeRawComputeHttpClient({
        apiKey: () => "prime-secret",
        sshKeyId: "ssh-key-1",
        image: "prime_rl",
        request: request as typeof fetch,
        now: () => new Date(NOW),
        verifySshHostKey: async () => "SHA256:ZmFrZQ",
      })
    );
    const inventory = await adapter.discover();

    await expect(
      adapter.acquire({
        runId: "prime-wallet-capped-run",
        deviceOrPool: inventory.devices[0]!.id,
        workerImageDigest: null,
        maximumSpendUsd: null,
        deadline: "2026-07-24T13:00:00.000Z",
      })
    ).rejects.toThrow("exceeds the available wallet balance of $1");
  });

  test("provisions the stock prime_rl image without a custom template", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const request = vi.fn(async (input: string | URL | Request, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/v1/billing/wallet?")) {
        return json({
          wallet_id: "wallet-1",
          team_id: null,
          balance_usd: 7.5,
          currency: "USD",
          total_billings: 0,
          recent_billings: [],
        });
      }
      if (url.includes("/availability/gpus?")) {
        return json({
          items: [
            {
              cloudId: "stock-prime-rl",
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
              images: ["prime_rl"],
              prices: { onDemand: 2.35, isVariable: false },
              prepaidTime: null,
            },
          ],
        });
      }
      if (url.endsWith("/api/v1/pods/?offset=0&limit=100")) {
        return json({ data: [] });
      }
      if (url.endsWith("/api/v1/pods/") && init.method === "POST") {
        return json(pod("PENDING", null), 201);
      }
      if (url.endsWith("/api/v1/pods/prime-node-1")) {
        return init.method === "DELETE"
          ? new Response(null, { status: 204 })
          : json(pod("RUNNING", "ssh openpond@gpu.example.test -p 22022"));
      }
      return json({}, 404);
    });
    const client = new PrimeRawComputeHttpClient({
      apiKey: () => "prime-secret",
      sshKeyId: "ssh-key-1",
      image: "prime_rl",
      request: request as typeof fetch,
      now: () => new Date(NOW),
      verifySshHostKey: async () => "SHA256:ZmFrZQ",
    });
    const inventory = await client.inventory();
    const onProvisioned = vi.fn();
    const lease = await client.provision({
      deviceOrPool: inventory.devices[0]!.id,
      deadline: "2026-07-24T12:30:00.000Z",
      idempotencyKey: "stock-image-smoke",
      onProvisioned,
    });
    await client.terminate(lease.nodeId);
    expect(onProvisioned).toHaveBeenCalledWith({
      nodeId: "prime-node-1",
      acquiredAt: NOW.toISOString(),
    });

    const create = calls.find(
      (call) =>
        call.url.endsWith("/api/v1/pods/") && call.init.method === "POST"
    );
    const body = JSON.parse(String(create?.init.body));
    expect(body.pod).toMatchObject({
      image: "prime_rl",
      sshKeyId: "ssh-key-1",
    });
    expect(body.pod).not.toHaveProperty("customTemplateId");
  });

  test("provisions the prebuilt vLLM image without a custom template", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const request = vi.fn(async (input: string | URL | Request, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/v1/billing/wallet?")) {
        return json({
          wallet_id: "wallet-1",
          team_id: null,
          balance_usd: 7.5,
          currency: "USD",
          total_billings: 0,
          recent_billings: [],
        });
      }
      if (url.includes("/availability/gpus?")) {
        return json({
          items: [
            {
              cloudId: "vllm-h100",
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
              images: ["vllm_llama_8b"],
              prices: { onDemand: 3.29, isVariable: false },
              prepaidTime: null,
            },
          ],
        });
      }
      if (url.endsWith("/api/v1/pods/?offset=0&limit=100")) {
        return json({ data: [] });
      }
      if (url.endsWith("/api/v1/pods/") && init.method === "POST") {
        return json(pod("PENDING", null), 201);
      }
      if (url.endsWith("/api/v1/pods/prime-node-1")) {
        return init.method === "DELETE"
          ? new Response(null, { status: 204 })
          : json(pod("RUNNING", "ssh openpond@gpu.example.test -p 22022"));
      }
      return json({}, 404);
    });
    const client = new PrimeRawComputeHttpClient({
      apiKey: () => "prime-secret",
      sshKeyId: "ssh-key-1",
      image: "vllm_llama_8b",
      request: request as typeof fetch,
      now: () => new Date(NOW),
      verifySshHostKey: async () => "SHA256:ZmFrZQ",
    });
    const inventory = await client.inventory();
    const lease = await client.provision({
      deviceOrPool: inventory.devices[0]!.id,
      deadline: "2026-07-24T12:30:00.000Z",
      idempotencyKey: "vllm-image-smoke",
    });
    await client.terminate(lease.nodeId);

    const create = calls.find(
      (call) =>
        call.url.endsWith("/api/v1/pods/") && call.init.method === "POST"
    );
    expect(JSON.parse(String(create?.init.body)).pod).toMatchObject({
      image: "vllm_llama_8b",
      sshKeyId: "ssh-key-1",
    });
  });
});

function pod(status: string, sshConnection: string | null) {
  return {
    id: "prime-node-1",
    name: "openpond-node",
    status,
    sshConnection,
    installationFailure: null,
    // Prime currently emits six fractional digits and no timezone marker.
    createdAt: NOW.toISOString().replace(".000Z", ".000000"),
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
