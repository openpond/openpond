import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { canonicalSha256, createTrainingClient, OPENPOND_TRAINING_MEDIA_TYPE } from "../src/training.js";

// Failure story: a cached list can be corrupted or label a different GPU as
// usable. An HTTP 200 must not turn that metadata into placement authority.
it("retains hardware identity across the HTTP boundary and rejects altered catalogs", async () => {
  const content = { schemaVersion: "openpond.trainingHardwareInventory.v1", provider: "fixture_provider", source: "fixture_inventory_v1",
    hardware: [{ id: "gpu-new", name: "New GPU", manufacturer: "NVIDIA", memoryGb: 192,
      secureCloud: true, communityCloud: false, maximumPerPod: { secure: 8, community: 0 } }] };
  const catalog = { schemaVersion: "openpond.trainingHardwareCatalog.v1",
    inventory: { ...content, version: await canonicalSha256(content), observedAt: "2026-10-31T00:00:00.000Z", refreshAfter: "2026-11-01T00:00:00.000Z" },
    workerImageDigest: `sha256:${"a".repeat(64)}`,
    eligibility: [{ gpuTypeId: "gpu-new", status: "not_admitted", reason: "gpu_type_not_enabled" }] };
  let mode = "valid";
  const requests: string[] = [];
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe("Bearer fixture");
    requests.push(`${request.method} ${request.url}`);
    const value = structuredClone(catalog);
    if (mode === "hash") value.inventory.hardware[0]!.memoryGb = 256;
    if (mode === "gpu") value.eligibility[0]!.gpuTypeId = "another-gpu";
    if (mode === "admission") value.eligibility[0]!.status = "requires_live_workload_check";
    response.writeHead(200, { "content-type": OPENPOND_TRAINING_MEDIA_TYPE }); response.end(JSON.stringify(value));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected HTTP listener");
    const client = createTrainingClient({ baseUrl: `http://127.0.0.1:${address.port}`, headers: { authorization: "Bearer fixture" } });
    expect(await client.hardwareCatalog()).toEqual(catalog);
    for (const invalid of ["hash", "gpu", "admission"]) {
      mode = invalid;
      await expect(client.hardwareCatalog()).rejects.toMatchObject({ code: invalid === "hash" ? "training_hardware_inventory_mismatch" : "training_hardware_catalog_mismatch" });
    }
    expect(new Set(requests)).toEqual(new Set(["GET /v1/training/hardware-catalog"]));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

// Protocol proof only: the HTTP peer supplies offers, not runtime qualification.
it("binds live GPU replies to the exact query and rejects stale or substituted offers", async () => {
  const query = { teamId: "team", modelId: "model", modelRevision: "revision", tokenizerRevision: "revision",
    chatTemplateHash: "a".repeat(64), method: "grpo" as const, loraRank: 16, gpuCount: 2 as const };
  const observed = new Date();
  const catalog = { schemaVersion: "openpond.trainingGpuCatalog.v1", observedAt: observed.toISOString(),
    expiresAt: new Date(observed.getTime() + 60_000).toISOString(), workerImageDigest: `sha256:${"a".repeat(64)}`,
    supportedLoraRanks: [16], pricingBasis: "retail_allocation_hourly_before_credits",
    scope: { query, requestHash: await canonicalSha256(query), qualification: "requires_preparation", reason: null,
      provider: { accountScopeId: "opaque-scope", product: "POD", cloud: "SECURE", countryCodes: ["US", "CA"],
        cudaVersions: ["12.8"], dataCenterId: null, minimumDiskGb: 130 } },
    offerings: [{ availabilityId: "offer", gpuType: "gpu", provider: "fixture_provider", region: "fixture_region", dataCenterId: null,
      gpuCount: 2, gpuMemoryGb: 80, stockStatus: "Medium", hourlyUsd: 7 }] };
  let mode = "valid";
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    expect(request.method).toBe("GET"); expect(url.pathname).toBe("/v1/training/gpu-catalog");
    expect(url.searchParams.get("gpuCount")).toBe("2"); expect(url.searchParams.get("teamId")).toBe("team");
    const value = structuredClone(catalog);
    if (mode === "hash") value.scope.requestHash = "0".repeat(64);
    if (mode === "count") value.offerings[0]!.gpuCount = 1;
    if (mode === "expired") value.expiresAt = value.observedAt;
    if (mode === "missing") delete (value as { scope?: unknown }).scope;
    if (mode === "supplier_fields") Object.assign(value.offerings[0]!, { computeHourlyUsd: 4, diskHourlyUsd: 0.01, totalHourlyUsd: 4.01 });
    response.writeHead(200, { "content-type": OPENPOND_TRAINING_MEDIA_TYPE }); response.end(JSON.stringify({ catalog: value }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected HTTP listener");
    const client = createTrainingClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    expect(await client.gpuCatalog(query)).toEqual(catalog);
    for (const invalid of ["hash", "count", "expired", "missing"]) {
      mode = invalid;
      await expect(client.gpuCatalog(query)).rejects.toMatchObject({ code: invalid === "expired" ? "training_gpu_catalog_expired" : "training_gpu_catalog_scope_mismatch" });
    }
    // Supplier economics must never become a second public price option.
    mode = "supplier_fields";
    await expect(client.gpuCatalog(query)).rejects.toMatchObject({ issues: expect.arrayContaining([
      expect.objectContaining({ code: "unrecognized_keys", path: ["offerings", 0] }),
    ]) });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
