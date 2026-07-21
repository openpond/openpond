import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createComputeService } from "../apps/server/src/compute/compute-service";
import { runCommandProbe, type CommandProbeResult } from "../apps/server/src/compute/command-probe";
import { parseLinuxCpu, parseNvidiaMigList, parseNvidiaSmiCsv, parseRocmSmiJson, parseXpuSmiJson } from "../apps/server/src/compute/linux-probes";
import { macOperatingSystem, parseMacCpu, parseSystemProfilerDisplays } from "../apps/server/src/compute/macos-probes";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("compute probes", () => {
  test("parses Linux CPU, memory, and multiple NVIDIA devices", () => {
    const cpu = parseLinuxCpu({
      lscpuJson: JSON.stringify({ lscpu: [{ field: "Architecture:", data: "x86_64" }, { field: "CPU(s):", data: "32" }, { field: "Core(s) per socket:", data: "8" }, { field: "Socket(s):", data: "2" }, { field: "Vendor ID:", data: "AuthenticAMD" }, { field: "Model name:", data: "AMD Test CPU" }] }),
      meminfo: "MemTotal:       65536 kB\nMemAvailable:   32768 kB\n",
    });
    expect(cpu).toMatchObject({ vendor: "amd", physicalCoreCount: 16, logicalCoreCount: 32, totalMemoryBytes: 67_108_864 });
    expect(parseNvidiaSmiCsv("0, RTX Test, 24576, 20000, 600.1, 9.0, Disabled\n1, RTX Test 2, 12288, 10000, 600.1, 8.9, Disabled\n")).toHaveLength(2);
    expect(parseNvidiaMigList("GPU 0: NVIDIA A100 (UUID: GPU-private)\n  MIG 1g.5gb Device 0: (UUID: MIG-private)\n")).toMatchObject([{ id: "nvidia:0:mig:0", totalMemoryBytes: 5_368_709_120 }]);
    expect(parseRocmSmiJson(JSON.stringify({ card0: { "Card series": "AMD Instinct Test", "VRAM Total Memory (B)": "17179869184", "VRAM Total Used Memory (B)": "1073741824" } }))).toMatchObject([{ vendor: "amd", freeMemoryBytes: 16_106_127_360 }]);
    expect(parseXpuSmiJson(JSON.stringify({ device_list: [{ device_id: 0, device_name: "Intel Data Center GPU", memory_physical_size_byte: 8589934592 }] }))).toMatchObject([{ vendor: "intel", totalMemoryBytes: 8_589_934_592 }]);
  });

  test("parses Apple host and accelerator details", () => {
    expect(parseMacCpu({ brand: "Apple M4 Max", physicalCores: "12", logicalCores: "12", memoryBytes: "68719476736" })).toMatchObject({ vendor: "apple", physicalCoreCount: 12 });
    expect(parseSystemProfilerDisplays(JSON.stringify({ SPDisplaysDataType: [{ sppci_model: "Apple M4 Max", spdisplays_vram_shared: "64 GB" }] }))[0]).toMatchObject({ vendor: "apple", totalMemoryBytes: 68_719_476_736 });
    expect(macOperatingSystem("ProductName:\t\tmacOS\nProductVersion:\t15.5\nBuildVersion:\t\t24F74\n")).toBe("macOS 15.5 (24F74)");
  });

  test("bounds command time and output", async () => {
    const timedOut = await runCommandProbe(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { timeoutMs: 20 });
    expect(timedOut.state).toBe("timeout");
    const truncated = await runCommandProbe(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], { maxOutputBytes: 100 });
    expect(truncated.state).toBe("truncated");
    const missing = await runCommandProbe("openpond-command-that-does-not-exist", []);
    expect(missing.state).toBe("missing");
  });

  test("persists normalized settings and a de-duplicated scan snapshot", async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-compute-"));
    temporaryDirectories.push(storeDir);
    const modelStore = path.join(storeDir, "models");
    const success = (stdout = ""): CommandProbeResult => ({ state: "success", stdout, stderr: "", exitCode: 0 });
    const missing = (): CommandProbeResult => ({ state: "missing", stdout: "", stderr: "", exitCode: null });
    const commandProbe = async (executable: string, args: readonly string[]) => {
      if (executable === "lscpu") return success(JSON.stringify({ lscpu: [{ field: "CPU(s):", data: "4" }, { field: "Vendor ID:", data: "GenuineIntel" }, { field: "Model name:", data: "Test CPU" }] }));
      if (executable === "uv") return success(JSON.stringify({ python: "3.12", torch: "2.9.1", transformers: "4.57.3", trl: "0.26.2", peft: "0.18.0" }));
      if (executable === "docker" && args[0] === "info") return missing();
      return missing();
    };
    const service = createComputeService({
      storeDir,
      localWorkerProjectDir: path.join(process.cwd(), "python", "openpond-training"),
      platform: "linux",
      commandProbe,
      now: () => new Date("2026-07-12T12:00:00.000Z"),
      storageCandidates: async () => [{
        kind: "local",
        label: "System disk",
        path: "/",
        modelStorePath: path.join(storeDir, "models"),
        datasetStorePath: path.join(storeDir, "datasets"),
      }],
    });
    await service.updateSettings({ modelStorePath: modelStore, additionalModelPaths: [modelStore, modelStore] });
    const inventory = await service.scan();
    expect(inventory.host.platform).toBe("linux");
    expect(inventory.runtimes.find((runtime) => runtime.kind === "trl_peft")?.state).toBe("available");
    expect(inventory.storageRoots).toHaveLength(1);
    expect(inventory.storageRoots[0]).toMatchObject({
      label: "System disk",
      modelStorePath: modelStore,
      datasetStorePath: path.join(storeDir, "datasets"),
      configured: true,
    });
    expect(JSON.parse(await readFile(path.join(storeDir, "compute", "inventory.json"), "utf8"))).toEqual(inventory);
  });
});
