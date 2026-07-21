import { describe, expect, test, vi } from "vitest";
import { createFireworksBaselineDeploymentService } from "../apps/server/src/training/fireworks-baseline-deployment";

describe("bounded Fireworks baseline deployment", () => {
  test("validates, starts, routes to, accounts for, and deletes one deployment", async () => {
    const calls: Array<{
      method: string;
      url: string;
      body: Record<string, unknown> | null;
    }> = [];
    let now = new Date("2026-07-20T21:00:00.000Z");
    const request = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        method,
        url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      if (url.endsWith("/v1/accounts")) {
        return json({ accounts: [{ name: "accounts/test-account" }] });
      }
      if (url.includes("/deployments?") && method === "POST") {
        return json({
          state: "READY",
          status: { code: "", message: "" },
          acceleratorCount: 1,
          minReplicaCount: 1,
          maxReplicaCount: 1,
        });
      }
      if (url.includes("/deployments/") && method === "GET") {
        return json({
          state: "READY",
          status: { code: "", message: "" },
          acceleratorCount: 1,
          minReplicaCount: 1,
          maxReplicaCount: 1,
        });
      }
      if (url.includes("/deployments/") && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected Fireworks request ${method} ${url}`);
    });
    const service = createFireworksBaselineDeploymentService({
      resolveCredential: async () => ({ value: "fw_test_secret" }),
      request: request as typeof fetch,
      now: () => now,
    });

    const updates: Array<{ statusCode: string | null; statusMessage: string | null; state: string | null }> = [];
    const lease = await service.prepare([{
      providerId: "fireworks",
      modelId: "accounts/fireworks/models/qwen3-0p6b",
    }], {
      onDeploymentUpdate: (update) => {
        updates.push(update);
      },
    });
    expect(lease.models[0]?.modelId).toMatch(
      /^accounts\/fireworks\/models\/qwen3-0p6b#accounts\/test-account\/deployments\/op-baseline-/,
    );
    const createCalls = calls.filter((call) =>
      call.method === "POST" && call.url.includes("/deployments?"));
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0]?.url).toContain("validateOnly=true");
    expect(createCalls[1]?.url).toContain("validateOnly=false");
    expect(createCalls[1]?.body).toMatchObject({
      baseModel: "accounts/fireworks/models/qwen3-0p6b",
      acceleratorCount: 1,
      acceleratorType: "NVIDIA_H100_80GB",
      minReplicaCount: 1,
      maxReplicaCount: 1,
      enableAddons: false,
    });

    now = new Date("2026-07-20T21:01:00.000Z");
    await expect(lease.release()).resolves.toEqual({ costUsd: 0.116667 });
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "DELETE",
        url: expect.stringContaining("/deployments/op-baseline-"),
      }),
    ]));
    expect(updates.every((update) =>
      update.statusCode !== "" && update.statusMessage !== "")).toBe(true);
    expect(updates.at(-1)).toMatchObject({
      state: "DELETED",
      statusCode: null,
      statusMessage: null,
    });
  });

  test("fails fast and deletes the deployment when Fireworks reports no capacity", async () => {
    const calls: Array<{ method: string; url: string }> = [];
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
          state: "CREATING",
          acceleratorCount: 1,
          minReplicaCount: 1,
          maxReplicaCount: 1,
        });
      }
      if (url.includes("/deployments/") && method === "GET") {
        return json({
          state: "CREATING",
          status: { code: "RESOURCE_EXHAUSTED", message: "no available capacity" },
          acceleratorCount: 1,
          minReplicaCount: 1,
          maxReplicaCount: 1,
        });
      }
      if (url.includes("/deployments/") && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected Fireworks request ${method} ${url}`);
    });
    const service = createFireworksBaselineDeploymentService({
      resolveCredential: async () => ({ value: "fw_test_secret" }),
      request: request as typeof fetch,
    });

    await expect(service.prepare([{
      providerId: "fireworks",
      modelId: "accounts/fireworks/models/qwen3-0p6b",
    }])).rejects.toThrow("no available capacity");
    expect(calls.some((call) =>
      call.method === "DELETE" && call.url.includes("/deployments/op-baseline-")))
      .toBe(true);
  });

  test("still deletes when lifecycle notifications fail and retries a failed delete", async () => {
    let deleteAttempts = 0;
    const request = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/v1/accounts")) {
        return json({ accounts: [{ name: "accounts/test-account" }] });
      }
      if (url.includes("/deployments?") && method === "POST") {
        return json({
          state: "READY",
          acceleratorCount: 1,
          minReplicaCount: 1,
          maxReplicaCount: 1,
        });
      }
      if (url.includes("/deployments/") && method === "GET") {
        return json({
          state: "READY",
          acceleratorCount: 1,
          minReplicaCount: 1,
          maxReplicaCount: 1,
        });
      }
      if (url.includes("/deployments/") && method === "DELETE") {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          return new Response("temporary provider failure", { status: 503 });
        }
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected Fireworks request ${method} ${url}`);
    });
    const service = createFireworksBaselineDeploymentService({
      resolveCredential: async () => ({ value: "fw_test_secret" }),
      request: request as typeof fetch,
    });
    const lease = await service.prepare([{
      providerId: "fireworks",
      modelId: "accounts/fireworks/models/qwen3-0p6b",
    }], {
      onDeploymentUpdate: (update) => {
        if (update.phase === "deleting" || update.phase === "deleted") {
          throw new Error("status persistence failed");
        }
      },
    });

    await expect(lease.release()).rejects.toThrow("503");
    await expect(lease.release()).resolves.toEqual({ costUsd: expect.any(Number) });
    expect(deleteAttempts).toBe(2);
  });

  test("cleans up orphaned OpenPond baseline deployments without touching other deployments", async () => {
    const deleted: string[] = [];
    const request = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/v1/accounts")) {
        return json({ accounts: [{ name: "accounts/test-account" }] });
      }
      if (url.endsWith("/deployments?pageSize=200") && method === "GET") {
        return json({ deployments: [
          { name: "accounts/test-account/deployments/op-baseline-orphan", state: "CREATING" },
          { name: "accounts/test-account/deployments/customer-serving", state: "READY" },
        ] });
      }
      if (method === "DELETE") {
        deleted.push(url);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected Fireworks request ${method} ${url}`);
    });
    const service = createFireworksBaselineDeploymentService({
      resolveCredential: async () => ({ value: "fw_test_secret" }),
      request: request as typeof fetch,
    });

    await expect(service.cleanupOrphanedDeployments())
      .resolves.toEqual(["op-baseline-orphan"]);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toContain("op-baseline-orphan");
    expect(deleted[0]).not.toContain("customer-serving");
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
