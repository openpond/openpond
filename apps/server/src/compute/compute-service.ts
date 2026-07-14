import { constants } from "node:fs";
import { access, mkdir, readFile, rename, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ComputeInventorySchema,
  ComputeSettingsSchema,
  ComputeStateResponseSchema,
  UpdateComputeSettingsRequestSchema,
  type ComputeDevice,
  type ComputeInventory,
  type ComputeRuntime,
  type ComputeSettings,
  type ComputeStorageRoot,
} from "@openpond/contracts";
import { runCommandProbe, type CommandProbe, type CommandProbeResult } from "./command-probe.js";
import { parseLinuxCpu, parseNvidiaMigList, parseNvidiaSmiCsv, parseOsRelease, parseRocmSmiJson, parseXpuSmiJson } from "./linux-probes.js";
import { macOperatingSystem, parseMacCpu, parseSystemProfilerDisplays } from "./macos-probes.js";
import { discoverModelAssets } from "./model-discovery.js";
import { createModelDownloadService } from "./model-download-service.js";
import { discoverStorageCandidates, storageKindForPath, type StorageCandidate } from "./storage-discovery.js";

type ComputeServiceDeps = {
  storeDir: string;
  localWorkerProjectDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  hostname?: string;
  commandProbe?: CommandProbe;
  now?: () => Date;
  storageCandidates?: () => Promise<StorageCandidate[]>;
};

export function createComputeService(deps: ComputeServiceDeps) {
  const directory = path.join(deps.storeDir, "compute");
  const settingsPath = path.join(directory, "settings.json");
  const inventoryPath = path.join(directory, "inventory.json");
  const commandProbe = deps.commandProbe ?? runCommandProbe;
  let scanPromise: Promise<ComputeInventory> | null = null;
  const modelDownloads = createModelDownloadService({ storeDir: deps.storeDir, projectDir: deps.localWorkerProjectDir, settings, onComplete: async () => { await scan(); } });

  async function settings(): Promise<ComputeSettings> {
    try {
      return ComputeSettingsSchema.parse(JSON.parse(await readFile(settingsPath, "utf8")));
    } catch {
      return defaultSettings();
    }
  }

  async function inventory(): Promise<ComputeInventory | null> {
    try {
      const stored = JSON.parse(await readFile(inventoryPath, "utf8")) as Record<string, unknown>;
      return ComputeInventorySchema.parse({ ...stored, connections: stored.connections ?? [], downloads: stored.downloads ?? [] });
    } catch {
      return null;
    }
  }

  async function state() {
    const snapshot = await inventory();
    return ComputeStateResponseSchema.parse({
      schemaVersion: "openpond.computeState.v1",
      settings: await settings(),
      inventory: snapshot ? { ...snapshot, downloads: await modelDownloads.list() } : null,
      scanning: scanPromise !== null,
    });
  }

  async function updateSettings(input: unknown): Promise<ComputeSettings> {
    const patch = UpdateComputeSettingsRequestSchema.parse(input);
    const current = await settings();
    const updated = ComputeSettingsSchema.parse({
      ...current,
      ...patch,
      modelStorePath: patch.modelStorePath === undefined ? current.modelStorePath : normalizeOptionalPath(patch.modelStorePath),
      additionalModelPaths: patch.additionalModelPaths === undefined ? current.additionalModelPaths : uniquePaths(patch.additionalModelPaths),
      updatedAt: timestamp(),
    });
    await atomicJson(settingsPath, updated);
    return updated;
  }

  async function scan(): Promise<ComputeInventory> {
    if (scanPromise) return scanPromise;
    scanPromise = runScan().finally(() => { scanPromise = null; });
    return scanPromise;
  }

  async function runScan(): Promise<ComputeInventory> {
    const currentSettings = await settings();
    const platform = deps.platform ?? process.platform;
    const result = platform === "linux"
      ? await scanLinux(commandProbe, currentSettings)
      : platform === "darwin"
        ? await scanMac(commandProbe, currentSettings)
        : await scanPortable(currentSettings, `Native compute discovery is not implemented for ${platform}.`);
    const parsed = ComputeInventorySchema.parse(result);
    await atomicJson(inventoryPath, parsed);
    return parsed;
  }

  function defaultSettings(): ComputeSettings {
    return ComputeSettingsSchema.parse({
      schemaVersion: "openpond.computeSettings.v1",
      modelStorePath: null,
      defaultDeviceIds: [],
      additionalModelPaths: [],
      updatedAt: timestamp(),
    });
  }

  function timestamp(): string { return (deps.now?.() ?? new Date()).toISOString(); }

  async function scanLinux(probe: CommandProbe, currentSettings: ComputeSettings): Promise<ComputeInventory> {
    const [lscpu, osRelease, meminfo, nvidia, nvidiaList, rocm, intel, docker, podman, python] = await Promise.all([
      probe("lscpu", ["-J"]),
      readText("/etc/os-release"),
      readText("/proc/meminfo"),
      probe("nvidia-smi", ["--query-gpu=index,name,memory.total,memory.free,driver_version,compute_cap,display_active", "--format=csv,noheader,nounits"]),
      probe("nvidia-smi", ["-L"]),
      probe("rocm-smi", ["--showproductname", "--showmeminfo", "vram", "--json"]),
      probe("xpu-smi", ["discovery", "-j"]),
      probe("docker", ["info", "--format", "{{json .ServerVersion}}"], { timeoutMs: 5_000 }),
      probe("podman", ["info", "--format", "json"], { timeoutMs: 5_000 }),
      pythonRuntimeProbe(probe, deps.localWorkerProjectDir),
    ]);
    const warnings: string[] = [];
    let cpu = portableCpu();
    if (lscpu.state === "success" && meminfo !== null) {
      try { cpu = parseLinuxCpu({ lscpuJson: lscpu.stdout, meminfo }); }
      catch { warnings.push("Linux CPU details could not be parsed; portable CPU values were used."); }
    } else warnings.push("lscpu or /proc/meminfo was unavailable; portable CPU values were used.");
    const devices: ComputeDevice[] = [cpu];
    if (nvidia.state === "success") {
      try { devices.push(...parseNvidiaSmiCsv(nvidia.stdout)); }
      catch { warnings.push("NVIDIA GPU details could not be parsed."); }
    }
    if (nvidiaList.state === "success") {
      try { devices.push(...parseNvidiaMigList(nvidiaList.stdout)); }
      catch { warnings.push("NVIDIA MIG details could not be parsed."); }
    }
    if (rocm.state === "success") {
      try { devices.push(...parseRocmSmiJson(rocm.stdout)); }
      catch { warnings.push("AMD ROCm device details could not be parsed."); }
    }
    if (intel.state === "success") {
      try { devices.push(...parseXpuSmiJson(intel.stdout)); }
      catch { warnings.push("Intel accelerator details could not be parsed."); }
    }
    return baseInventory({
      settings: currentSettings,
      operatingSystem: osRelease ? parseOsRelease(osRelease) : "Linux",
      devices,
      runtimes: [
        runtimeFrom("cuda", "cuda", nvidia, nvidia.state === "success" ? firstCsvField(nvidia.stdout, 4) : null),
        runtimeFrom("rocm", "rocm", rocm),
        runtimeFrom("docker", "docker", docker, jsonString(docker.stdout)),
        runtimeFrom("podman", "podman", podman),
        ...python,
        unavailableRuntime("mlx", "mlx", "MLX is only supported on Apple silicon."),
        await ollamaRuntime(probe),
      ],
      warnings,
    });
  }

  async function scanMac(probe: CommandProbe, currentSettings: ComputeSettings): Promise<ComputeInventory> {
    const [swVers, brand, physical, logical, memory, profiler, mlx, python, ollama] = await Promise.all([
      probe("sw_vers", []),
      probe("sysctl", ["-n", "machdep.cpu.brand_string"]),
      probe("sysctl", ["-n", "hw.physicalcpu"]),
      probe("sysctl", ["-n", "hw.logicalcpu"]),
      probe("sysctl", ["-n", "hw.memsize"]),
      probe("system_profiler", ["SPHardwareDataType", "SPDisplaysDataType", "SPMemoryDataType", "-json"], { timeoutMs: 20_000, maxOutputBytes: 2_000_000 }),
      probe("python3", ["-c", "import json; import mlx; print(json.dumps({'version': getattr(mlx, '__version__', None)}))"]),
      pythonRuntimeProbe(probe, deps.localWorkerProjectDir),
      ollamaRuntime(probe),
    ]);
    const warnings: string[] = [];
    const cpu = [brand, physical, logical, memory].every((result) => result.state === "success")
      ? parseMacCpu({ brand: brand.stdout, physicalCores: physical.stdout, logicalCores: logical.stdout, memoryBytes: memory.stdout })
      : portableCpu("apple");
    let displays: ComputeDevice[] = [];
    if (profiler.state === "success") {
      try { displays = parseSystemProfilerDisplays(profiler.stdout); }
      catch { warnings.push("macOS display details could not be parsed."); }
    } else warnings.push("system_profiler was unavailable; accelerator details may be incomplete.");
    return baseInventory({
      settings: currentSettings,
      operatingSystem: swVers.state === "success" ? macOperatingSystem(swVers.stdout) : "macOS",
      devices: [cpu, ...displays],
      runtimes: [
        runtimeFrom("mlx", "mlx", mlx, jsonVersion(mlx.stdout)),
        ...python,
        ollama,
        unavailableRuntime("cuda", "cuda", "CUDA is not supported on macOS."),
        unavailableRuntime("rocm", "rocm", "ROCm training is not supported on macOS."),
      ],
      warnings,
    });
  }

  async function scanPortable(currentSettings: ComputeSettings, warning: string): Promise<ComputeInventory> {
    return baseInventory({ settings: currentSettings, operatingSystem: `${os.type()} ${os.release()}`, devices: [portableCpu()], runtimes: [], warnings: [warning] });
  }

  async function baseInventory(input: { settings: ComputeSettings; operatingSystem: string; devices: ComputeDevice[]; runtimes: ComputeRuntime[]; warnings: string[] }): Promise<ComputeInventory> {
    const discovered = await discoverModelAssets(input.settings, timestamp());
    return {
      schemaVersion: "openpond.computeInventory.v1",
      host: {
        platform: normalizedPlatform(deps.platform ?? process.platform),
        architecture: deps.arch ?? process.arch,
        operatingSystem: input.operatingSystem,
        hostname: deps.hostname ?? os.hostname(),
        totalMemoryBytes: os.totalmem(),
      },
      devices: input.devices,
      runtimes: input.runtimes,
      storageRoots: await storageRoots(input.settings),
      connections: [{ id: "local", kind: "local", label: "This machine", configured: true, available: true, lastCheckedAt: timestamp(), unavailableReason: null }],
      models: discovered.models,
      downloads: await modelDownloads.list(),
      warnings: [...input.warnings, ...discovered.warnings],
      scannedAt: timestamp(),
    };
  }

  async function storageRoots(currentSettings: ComputeSettings): Promise<ComputeStorageRoot[]> {
    const platform = deps.platform ?? process.platform;
    const discovered = deps.storageCandidates
      ? await deps.storageCandidates()
      : await discoverStorageCandidates({ commandProbe, platform, storeDir: deps.storeDir });
    const configuredPaths = new Set([currentSettings.modelStorePath, ...currentSettings.additionalModelPaths].filter((value): value is string => Boolean(value)).map(normalizedPath));
    const candidates: StorageCandidate[] = [...discovered];
    if (currentSettings.modelStorePath && !discovered.some((candidate) => normalizedPath(candidate.modelStorePath) === normalizedPath(currentSettings.modelStorePath!))) {
      candidates.push({ path: currentSettings.modelStorePath, modelStorePath: currentSettings.modelStorePath, label: "Manual location", kind: storageKindForPath(currentSettings.modelStorePath) });
    }
    for (const candidate of currentSettings.additionalModelPaths) {
      if (candidates.some((existing) => normalizedPath(existing.path) === normalizedPath(candidate) || normalizedPath(existing.modelStorePath) === normalizedPath(candidate))) continue;
      candidates.push({ path: candidate, modelStorePath: candidate, label: path.basename(candidate) || candidate, kind: storageKindForPath(candidate) });
    }
    return Promise.all(uniqueByPath(candidates).map(async (candidate) => {
      const resolved = path.resolve(candidate.path);
      let mounted = false;
      let writable = false;
      let totalBytes: number | null = null;
      let freeBytes: number | null = null;
      try {
        const stats = await statfs(resolved);
        mounted = true;
        totalBytes = safeBytes(stats.blocks, stats.bsize);
        freeBytes = safeBytes(stats.bavail, stats.bsize);
        writable = await canWriteOrCreate(candidate.modelStorePath);
      } catch { /* An absent or read-only configured root remains visible. */ }
      return {
        id: `storage:${pathId(resolved)}`,
        label: candidate.label,
        path: resolved,
        modelStorePath: path.resolve(candidate.modelStorePath),
        kind: candidate.kind,
        configured: configuredPaths.has(normalizedPath(candidate.modelStorePath)) || configuredPaths.has(normalizedPath(candidate.path)),
        mounted,
        writable,
        totalBytes,
        freeBytes,
      };
    }));
  }

  async function modelPath(modelId: string, revision: string): Promise<string | null> {
    const current = await inventory() ?? await scan();
    return current.models.find((model) => model.modelId === modelId && model.revision === revision && model.trainingCompatible)?.path ?? null;
  }

  return { state, settings, inventory, updateSettings, scan, modelPath, startModelDownload: modelDownloads.start, cancelModelDownload: modelDownloads.cancel, close: modelDownloads.close };
}

async function pythonRuntimeProbe(probe: CommandProbe, projectDir: string): Promise<ComputeRuntime[]> {
  const script = "import json, importlib.metadata as m; print(json.dumps({'python': __import__('platform').python_version(), 'torch': m.version('torch'), 'transformers': m.version('transformers'), 'trl': m.version('trl'), 'peft': m.version('peft')}))";
  const result = await probe("uv", ["run", "--project", projectDir, "python", "-c", script], { timeoutMs: 30_000 });
  if (result.state !== "success") {
    const detail = commandDetail(result);
    return [unavailableRuntime("python", "python", detail), unavailableRuntime("trl_peft", "trl_peft", detail)];
  }
  try {
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    return [
      availableRuntime("python", "python", stringValue(parsed.python), "uv"),
      availableRuntime("trl_peft", "trl_peft", [parsed.trl, parsed.peft, parsed.transformers, parsed.torch].filter((item) => typeof item === "string").join(" / ") || null, "uv"),
    ];
  } catch {
    return [unavailableRuntime("python", "python", "The Python worker returned invalid capability JSON."), unavailableRuntime("trl_peft", "trl_peft", "The Python worker returned invalid capability JSON.")];
  }
}

async function ollamaRuntime(probe: CommandProbe): Promise<ComputeRuntime> {
  const result = await probe("ollama", ["--version"], { timeoutMs: 5_000 });
  return runtimeFrom("ollama", "ollama", result, result.state === "success" ? result.stdout.trim().replace(/^ollama version(?: is)?\s*/i, "") || null : null);
}

function runtimeFrom(id: ComputeRuntime["id"], kind: ComputeRuntime["kind"], result: CommandProbeResult, version: string | null = null): ComputeRuntime {
  return result.state === "success" ? availableRuntime(id, kind, version, id) : unavailableRuntime(id, kind, commandDetail(result));
}
function availableRuntime(id: string, kind: ComputeRuntime["kind"], version: string | null, executable: string): ComputeRuntime { return { id, kind, state: "available", version, executable, detail: null }; }
function unavailableRuntime(id: string, kind: ComputeRuntime["kind"], detail: string): ComputeRuntime { return { id, kind, state: "unavailable", version: null, executable: null, detail }; }
function commandDetail(result: CommandProbeResult): string { return result.state === "missing" ? "Executable not found." : result.state === "timeout" ? "Capability probe timed out." : result.state === "truncated" ? "Capability probe exceeded its output limit." : result.stderr.trim().slice(0, 2_000) || "Capability probe failed."; }

function portableCpu(vendor: ComputeDevice["vendor"] = "other"): ComputeDevice {
  return { id: "cpu:0", kind: "cpu", vendor, index: 0, name: os.cpus()[0]?.model || "CPU", totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(), physicalCoreCount: null, logicalCoreCount: os.cpus().length || null, driverVersion: null, runtimeVersion: null, computeCapability: null, supportedPrecisions: ["fp32"], available: true, unavailableReason: null };
}
async function readText(filePath: string): Promise<string | null> { try { return await readFile(filePath, "utf8"); } catch { return null; } }
async function atomicJson(filePath: string, value: unknown): Promise<void> { await mkdir(path.dirname(filePath), { recursive: true }); const temporary = `${filePath}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(temporary, filePath); }
function normalizedPlatform(platform: NodeJS.Platform): "darwin" | "linux" | "win32" | "other" { return platform === "darwin" || platform === "linux" || platform === "win32" ? platform : "other"; }
function normalizeOptionalPath(value: string | null): string | null {
  if (!value) return null;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) throw new Error("Choose the mounted folder path instead of a network URL. Mount the share in your operating system first.");
  const expanded = value === "~" ? os.homedir() : value.startsWith(`~${path.sep}`) ? path.join(os.homedir(), value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) throw new Error("Model storage must be an absolute mounted folder path.");
  return path.resolve(expanded);
}
function uniquePaths(values: string[]): string[] { return [...new Set(values.map((value) => path.resolve(value)))]; }
function uniqueByPath<T extends { path: string }>(values: T[]): T[] { const seen = new Set<string>(); return values.filter((value) => { const resolved = path.resolve(value.path); if (seen.has(resolved)) return false; seen.add(resolved); return true; }); }
function safeBytes(blocks: number | bigint, size: number | bigint): number | null { const value = Number(blocks) * Number(size); return Number.isSafeInteger(value) && value >= 0 ? value : null; }
async function canWriteOrCreate(target: string): Promise<boolean> {
  let candidate = path.resolve(target);
  while (true) {
    try { await access(candidate, constants.W_OK); return true; }
    catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
}
function normalizedPath(value: string): string { const normalized = path.normalize(value); return process.platform === "win32" ? normalized.toLowerCase() : normalized; }
function pathId(value: string): string { let hash = 2166136261; for (const character of normalizedPath(value)) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(36); }
function firstCsvField(csv: string, index: number): string | null { const value = csv.split(/\r?\n/, 1)[0]?.split(",")[index]?.trim(); return value || null; }
function jsonString(value: string): string | null { try { const parsed = JSON.parse(value); return typeof parsed === "string" ? parsed : null; } catch { return null; } }
function jsonVersion(value: string): string | null { try { const parsed = JSON.parse(value) as { version?: unknown }; return stringValue(parsed.version); } catch { return null; } }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
