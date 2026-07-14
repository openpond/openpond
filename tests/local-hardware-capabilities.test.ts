import { describe, expect, test } from "bun:test";
import { ComputeInventorySchema, type ComputeDevice, type ComputeInventory, type ComputeRuntime } from "@openpond/contracts";
import { capabilityReason } from "../apps/server/src/training/hardware-gated-destination";

describe("hardware-gated local training", () => {
  test("reports exact CUDA gates without claiming discovered hardware is proven", () => {
    expect(capabilityReason("local_cuda", inventory())).toBe("No supported NVIDIA GPU was detected.");
    expect(capabilityReason("local_cuda", inventory({ devices: [nvidia()], runtimes: [runtime("cuda", "unavailable")] }))).toBe("An NVIDIA GPU was found, but the CUDA runtime probe did not pass.");
    expect(capabilityReason("local_cuda", inventory({ devices: [nvidia()], runtimes: [runtime("cuda", "available")] }))).toBe("CUDA hardware is compatible, but this machine has no recorded live worker conformance proof yet.");
  });

  test("reports exact Apple Silicon and MLX gates", () => {
    expect(capabilityReason("local_mlx", inventory())).toBe("The MLX worker requires Apple silicon.");
    const apple = inventory({ platform: "darwin", architecture: "arm64", devices: [{ ...nvidia(), id: "apple:0", name: "Apple M4", kind: "accelerator", vendor: "apple" }], runtimes: [runtime("mlx", "available")] });
    expect(capabilityReason("local_mlx", apple)).toBe("MLX hardware is compatible, but this machine has no recorded live worker conformance proof yet.");
  });
});

function inventory(input: { platform?: "linux" | "darwin"; architecture?: string; devices?: ComputeDevice[]; runtimes?: ComputeRuntime[] } = {}): ComputeInventory {
  return ComputeInventorySchema.parse({ schemaVersion: "openpond.computeInventory.v1", host: { platform: input.platform ?? "linux", architecture: input.architecture ?? "x64", operatingSystem: "Test OS", hostname: "test", totalMemoryBytes: 16_000_000_000 }, devices: input.devices ?? [], runtimes: input.runtimes ?? [], storageRoots: [], connections: [], models: [], downloads: [], warnings: [], scannedAt: "2026-07-12T12:00:00.000Z" });
}
function nvidia(): ComputeDevice { return { id: "nvidia:0", kind: "gpu", vendor: "nvidia", index: 0, name: "NVIDIA Test", totalMemoryBytes: 24_000_000_000, freeMemoryBytes: 20_000_000_000, physicalCoreCount: null, logicalCoreCount: null, driverVersion: "600", runtimeVersion: null, computeCapability: "9.0", supportedPrecisions: ["fp32", "fp16", "bf16"], available: true, unavailableReason: null }; }
function runtime(kind: "cuda" | "mlx", state: "available" | "unavailable"): ComputeRuntime { return { id: kind, kind, state, version: state === "available" ? "test" : null, executable: state === "available" ? kind : null, detail: state === "available" ? null : "missing" }; }
