import type { ComputeDevice } from "@openpond/contracts";

type LscpuField = { field?: string; data?: string };

export function parseLinuxCpu(input: { lscpuJson: string; meminfo: string }): ComputeDevice {
  const parsed = JSON.parse(input.lscpuJson) as { lscpu?: LscpuField[] };
  const fields = new Map((parsed.lscpu ?? []).map((item) => [normalizeField(item.field), item.data?.trim() ?? ""]));
  const totalMemoryBytes = meminfoBytes(input.meminfo, "MemTotal");
  const freeMemoryBytes = meminfoBytes(input.meminfo, "MemAvailable");
  return {
    id: "cpu:0",
    kind: "cpu",
    vendor: cpuVendor(fields.get("vendor id") ?? ""),
    index: 0,
    name: fields.get("model name") || fields.get("architecture") || "CPU",
    totalMemoryBytes,
    freeMemoryBytes,
    physicalCoreCount: positiveInt(fields.get("core(s) per socket"), fields.get("socket(s)")),
    logicalCoreCount: positiveInt(fields.get("cpu(s)")),
    driverVersion: null,
    runtimeVersion: null,
    computeCapability: null,
    supportedPrecisions: ["fp32"],
    available: true,
    unavailableReason: null,
  };
}

export function parseNvidiaSmiCsv(csv: string): ComputeDevice[] {
  return csv.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    const fields = line.split(",").map((value) => value.trim());
    if (fields.length < 7) return [];
    const [index, name, totalMiB, freeMiB, driverVersion, computeCapability, displayActive] = fields;
    const parsedIndex = Number.parseInt(index ?? "", 10);
    if (!Number.isInteger(parsedIndex)) return [];
    return [{
      id: `nvidia:${parsedIndex}`,
      kind: "gpu" as const,
      vendor: "nvidia" as const,
      index: parsedIndex,
      name: name || `NVIDIA GPU ${parsedIndex}`,
      totalMemoryBytes: mib(totalMiB),
      freeMemoryBytes: mib(freeMiB),
      physicalCoreCount: null,
      logicalCoreCount: null,
      driverVersion: driverVersion || null,
      runtimeVersion: null,
      computeCapability: computeCapability || null,
      supportedPrecisions: ["fp32", "fp16", "bf16", "tf32", "int8", "int4"] as ComputeDevice["supportedPrecisions"],
      available: true,
      unavailableReason: null,
      // Deliberately ignore display state. It is queried only to keep a stable, documented CSV shape.
      ...(displayActive ? {} : {}),
    }];
  });
}

export function parseNvidiaMigList(text: string): ComputeDevice[] {
  let gpuIndex = -1;
  let migIndex = 0;
  const devices: ComputeDevice[] = [];
  for (const line of text.split(/\r?\n/)) {
    const gpu = /^GPU\s+(\d+):/.exec(line.trim());
    if (gpu) { gpuIndex = Number.parseInt(gpu[1]!, 10); migIndex = 0; continue; }
    const mig = /^MIG\s+(.+?)\s+Device\s+(\d+):/i.exec(line.trim());
    if (!mig || gpuIndex < 0) continue;
    const profile = mig[1]!.trim();
    const parsedIndex = Number.parseInt(mig[2]!, 10);
    devices.push({
      id: `nvidia:${gpuIndex}:mig:${Number.isInteger(parsedIndex) ? parsedIndex : migIndex}`,
      kind: "accelerator",
      vendor: "nvidia",
      index: Number.isInteger(parsedIndex) ? parsedIndex : migIndex,
      name: `NVIDIA MIG ${profile}`,
      totalMemoryBytes: migProfileBytes(profile),
      freeMemoryBytes: null,
      physicalCoreCount: null,
      logicalCoreCount: null,
      driverVersion: null,
      runtimeVersion: null,
      computeCapability: null,
      supportedPrecisions: ["fp32", "fp16", "bf16", "tf32", "int8", "int4"],
      available: true,
      unavailableReason: null,
    });
    migIndex += 1;
  }
  return devices;
}

export function parseRocmSmiJson(json: string): ComputeDevice[] {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  return Object.entries(parsed).flatMap(([key, raw], index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const value = raw as Record<string, unknown>;
    const name = firstString(value, ["Card series", "Card model", "Device Name", "Marketing Name"]);
    if (!name) return [];
    const totalMemoryBytes = firstNumber(value, ["VRAM Total Memory (B)", "VRAM Total Used Memory (B)"]);
    const usedMemoryBytes = firstNumber(value, ["VRAM Total Used Memory (B)"]);
    const cardIndex = Number.parseInt(key.replace(/\D/g, ""), 10);
    return [{ id: `amd:${Number.isInteger(cardIndex) ? cardIndex : index}`, kind: "gpu" as const, vendor: "amd" as const, index: Number.isInteger(cardIndex) ? cardIndex : index, name, totalMemoryBytes, freeMemoryBytes: totalMemoryBytes !== null && usedMemoryBytes !== null ? Math.max(0, totalMemoryBytes - usedMemoryBytes) : null, physicalCoreCount: null, logicalCoreCount: null, driverVersion: firstString(value, ["Driver version"]), runtimeVersion: null, computeCapability: firstString(value, ["GFX Version"]), supportedPrecisions: ["fp32", "fp16", "bf16", "int8"] as ComputeDevice["supportedPrecisions"], available: true, unavailableReason: null }];
  });
}

export function parseXpuSmiJson(json: string): ComputeDevice[] {
  const parsed = JSON.parse(json) as { device_list?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  const rows = Array.isArray(parsed) ? parsed : parsed.device_list ?? [];
  return rows.flatMap((value, index) => {
    const name = firstString(value, ["device_name", "name", "deviceName"]);
    if (!name) return [];
    const parsedIndex = firstNumber(value, ["device_id", "deviceId"]);
    const deviceIndex = parsedIndex === null ? index : parsedIndex;
    return [{ id: `intel:${deviceIndex}`, kind: "gpu" as const, vendor: "intel" as const, index: deviceIndex, name, totalMemoryBytes: firstNumber(value, ["memory_physical_size_byte", "memorySize"]), freeMemoryBytes: null, physicalCoreCount: null, logicalCoreCount: null, driverVersion: firstString(value, ["driver_version", "driverVersion"]), runtimeVersion: null, computeCapability: null, supportedPrecisions: ["fp32", "fp16", "bf16", "int8"] as ComputeDevice["supportedPrecisions"], available: true, unavailableReason: null }];
  });
}

export function parseOsRelease(text: string): string {
  const fields = new Map(text.split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) return [];
    return [[match[1]!, match[2]!.replace(/^['"]|['"]$/g, "")]] as Array<[string, string]>;
  }));
  return fields.get("PRETTY_NAME") || fields.get("NAME") || "Linux";
}

function normalizeField(value: string | undefined): string { return (value ?? "").replace(/:\s*$/, "").trim().toLowerCase(); }
function cpuVendor(value: string): "intel" | "amd" | "other" {
  const normalized = value.toLowerCase();
  if (normalized.includes("intel")) return "intel";
  if (normalized.includes("amd")) return "amd";
  return "other";
}
function positiveInt(first: string | undefined, second?: string | undefined): number | null {
  const a = Number.parseInt(first ?? "", 10);
  const b = second === undefined ? 1 : Number.parseInt(second, 10);
  return Number.isInteger(a) && a > 0 && Number.isInteger(b) && b > 0 ? a * b : null;
}
function meminfoBytes(text: string, key: string): number | null {
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m").exec(text);
  return match ? Number.parseInt(match[1]!, 10) * 1024 : null;
}
function mib(value: string | undefined): number | null {
  const parsed = Number.parseFloat((value ?? "").replace(/\s*MiB$/i, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1024 * 1024) : null;
}
function migProfileBytes(profile: string): number | null { const match = /(\d+(?:\.\d+)?)gb/i.exec(profile); return match ? Math.round(Number.parseFloat(match[1]!) * 1024 ** 3) : null; }
function firstString(value: Record<string, unknown>, keys: string[]): string | null { for (const key of keys) { const candidate = value[key]; if (typeof candidate === "string" && candidate.trim()) return candidate.trim(); } return null; }
function firstNumber(value: Record<string, unknown>, keys: string[]): number | null { for (const key of keys) { const candidate = value[key]; const parsed = typeof candidate === "number" ? candidate : typeof candidate === "string" ? Number.parseInt(candidate.replace(/[^\d]/g, ""), 10) : Number.NaN; if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed; } return null; }
