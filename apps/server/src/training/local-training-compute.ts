import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LocalTrainingCompute } from "@openpond/contracts/resource-setup";

const execFileAsync = promisify(execFile);

export async function inspectLocalTrainingCompute(): Promise<LocalTrainingCompute> {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      "--query-gpu=name,memory.total,memory.free",
      "--format=csv,noheader,nounits",
    ], { timeout: 2_500, maxBuffer: 64_000, windowsHide: true });
    const devices = stdout.trim().split(/\r?\n/).flatMap(line => {
      const columns = line.split(",").map(value => value.trim());
      const freeMiB = Number(columns.pop());
      const memoryMiB = Number(columns.pop());
      const name = columns.join(", ");
      if (!name || !Number.isSafeInteger(freeMiB) || !Number.isSafeInteger(memoryMiB) ||
        memoryMiB <= 0 || freeMiB < 0 || freeMiB > memoryMiB) return [];
      return [{ name, memoryMiB, freeMiB }];
    });
    return { status: devices.length ? "cuda_detected" : "devices_unavailable", devices };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "cuda_tools_unavailable" : "devices_unavailable", devices: [] };
  }
}
