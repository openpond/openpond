import type { ComputeDevice } from "@openpond/contracts";

type HardwareItem = Record<string, unknown>;

export function parseMacCpu(input: { brand: string; physicalCores: string; logicalCores: string; memoryBytes: string }): ComputeDevice {
  return {
    id: "cpu:0",
    kind: "cpu",
    vendor: input.brand.toLowerCase().includes("apple") ? "apple" : input.brand.toLowerCase().includes("intel") ? "intel" : "other",
    index: 0,
    name: input.brand.trim() || "Apple CPU",
    totalMemoryBytes: integerOrNull(input.memoryBytes),
    freeMemoryBytes: null,
    physicalCoreCount: positiveIntegerOrNull(input.physicalCores),
    logicalCoreCount: positiveIntegerOrNull(input.logicalCores),
    driverVersion: null,
    runtimeVersion: null,
    computeCapability: null,
    supportedPrecisions: ["fp32"],
    available: true,
    unavailableReason: null,
  };
}

export function parseSystemProfilerDisplays(json: string): ComputeDevice[] {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const displays = arrayForKey(parsed, "SPDisplaysDataType");
  return displays.flatMap((item, index) => {
    const name = stringField(item, "sppci_model") ?? stringField(item, "_name");
    if (!name) return [];
    const vendor = name.toLowerCase().includes("apple") ? "apple" : name.toLowerCase().includes("amd") ? "amd" : name.toLowerCase().includes("intel") ? "intel" : "other";
    const vram = parseProfilerMemory(stringField(item, "spdisplays_vram") ?? stringField(item, "spdisplays_vram_shared"));
    return [{
      id: `${vendor}:${index}`,
      kind: vendor === "apple" ? "accelerator" as const : "gpu" as const,
      vendor,
      index,
      name,
      totalMemoryBytes: vram,
      freeMemoryBytes: null,
      physicalCoreCount: null,
      logicalCoreCount: null,
      driverVersion: null,
      runtimeVersion: null,
      computeCapability: null,
      supportedPrecisions: vendor === "apple" ? ["fp32", "fp16", "bf16", "int8", "int4"] : ["fp32", "fp16"],
      available: true,
      unavailableReason: null,
    } satisfies ComputeDevice];
  });
}

export function macOperatingSystem(swVers: string): string {
  const values = new Map(swVers.split(/\r?\n/).flatMap((line) => {
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    return match ? [[match[1]!.trim(), match[2]!.trim()] as [string, string]] : [];
  }));
  const name = values.get("ProductName") ?? "macOS";
  const version = values.get("ProductVersion");
  const build = values.get("BuildVersion");
  return [name, version, build ? `(${build})` : null].filter(Boolean).join(" ");
}

function arrayForKey(value: Record<string, unknown>, key: string): HardwareItem[] {
  const candidate = value[key];
  return Array.isArray(candidate) ? candidate.filter((item): item is HardwareItem => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}
function stringField(value: HardwareItem, key: string): string | null { return typeof value[key] === "string" && value[key].trim() ? value[key].trim() : null; }
function integerOrNull(value: string): number | null { const parsed = Number.parseInt(value.trim(), 10); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null; }
function positiveIntegerOrNull(value: string): number | null { const parsed = integerOrNull(value); return parsed && parsed > 0 ? parsed : null; }
function parseProfilerMemory(value: string | null): number | null {
  if (!value) return null;
  const match = /([\d.]+)\s*(GB|MB)/i.exec(value);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]!);
  return Math.round(amount * (match[2]!.toUpperCase() === "GB" ? 1024 ** 3 : 1024 ** 2));
}
