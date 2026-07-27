import { describe, expect, test } from "vitest";
import {
  ComputeInventorySchema,
  ComputeSettingsSchema,
  ModelAssetSchema,
  PrimeComputeProviderStatusSchema,
  SavePrimeComputeCredentialRequestSchema,
} from "@openpond/contracts";

describe("compute contracts", () => {
  test("accepts a normalized inventory without raw command or hardware identifiers", () => {
    const inventory = ComputeInventorySchema.parse({
      schemaVersion: "openpond.computeInventory.v1",
      host: { platform: "linux", architecture: "x64", operatingSystem: "Test Linux", hostname: "workstation", totalMemoryBytes: 1024 },
      devices: [{ id: "cpu:0", kind: "cpu", vendor: "amd", index: 0, name: "Test CPU", totalMemoryBytes: 1024, freeMemoryBytes: 512, physicalCoreCount: 8, logicalCoreCount: 16, driverVersion: null, runtimeVersion: null, computeCapability: null, supportedPrecisions: ["fp32"], available: true, unavailableReason: null, serialNumber: "must-be-stripped" }],
      runtimes: [],
      storageRoots: [],
      connections: [],
      models: [],
      downloads: [],
      warnings: [],
      scannedAt: "2026-07-12T12:00:00.000Z",
      rawCommandOutput: "must-be-stripped",
    });
    expect(inventory.devices[0]).not.toHaveProperty("serialNumber");
    expect(inventory).not.toHaveProperty("rawCommandOutput");
  });

  test("rejects impossible byte counts and incomplete model lineage", () => {
    expect(ComputeSettingsSchema.safeParse({ schemaVersion: "openpond.computeSettings.v1", modelStorePath: null, defaultDeviceIds: [], additionalModelPaths: [], updatedAt: "not-a-date" }).success).toBe(false);
    expect(ModelAssetSchema.safeParse({ name: "model", source: "huggingface", sizeBytes: -1 }).success).toBe(false);
  });

  test("keeps Prime credential input separate from redacted provider status", () => {
    const request = SavePrimeComputeCredentialRequestSchema.parse({
      apiKey: "  prime-secret  ",
    });
    const status = PrimeComputeProviderStatusSchema.parse({
      schemaVersion: "openpond.primeComputeProviderStatus.v1",
      providerId: "prime",
      displayName: "Prime Intellect",
      state: "credential_valid",
      credential: {
        configured: true,
        redacted: "••••••••••••",
        storedLocally: true,
      },
      availability: {
        availableOfferingCount: 2,
        lowestHourlyUsd: 1.25,
        registeredSshKeyCount: 1,
      },
      worker: {
        ready: false,
        status: "setup_required",
        message: "Worker setup remains.",
        issues: ["Publish a pinned worker image."],
      },
      lastValidatedAt: "2026-07-24T12:00:00.000Z",
      lastError: null,
      apiKey: "must-be-stripped",
    });

    expect(request.apiKey).toBe("prime-secret");
    expect(status).not.toHaveProperty("apiKey");
    expect(JSON.stringify(status)).not.toContain("prime-secret");
  });
});
