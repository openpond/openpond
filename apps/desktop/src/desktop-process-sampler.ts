import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_SAMPLE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PROCESS_ROWS = 128;

export type ProcessTreeRow = {
  pid: number;
  ppid: number;
  cpuPercent: number;
  rssBytes: number;
};

export type ProcessTreeSample = {
  sampledAt: string;
  rootPid: number;
  processCount: number;
  cpuPercent: number;
  rssBytes: number;
  processes: ProcessTreeRow[];
};

export type ProcessTreeSamplerSnapshot = {
  activePid: number | null;
  sampleIntervalMs: number;
  maxSamples: number;
  maxProcessRows: number;
  samples: ProcessTreeSample[];
  lastError: string | null;
};

export class DesktopProcessTreeSampler {
  private readonly sampleIntervalMs: number;
  private readonly maxSamples: number;
  private readonly dateNow: () => string;
  private readonly sampler: typeof sampleProcessTree;
  private readonly maxProcessRows: number;
  private activePid: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private samples: ProcessTreeSample[] = [];
  private lastError: string | null = null;
  private inFlight: Promise<ProcessTreeSample | null> | null = null;

  constructor(options: {
    sampleIntervalMs?: number;
    maxSamples?: number;
    dateNow?: () => string;
    sampler?: typeof sampleProcessTree;
    maxProcessRows?: number;
  } = {}) {
    this.sampleIntervalMs = Math.max(1_000, Math.trunc(options.sampleIntervalMs ?? 15_000));
    this.maxSamples = Math.max(1, Math.trunc(options.maxSamples ?? 120));
    this.dateNow = options.dateNow ?? (() => new Date().toISOString());
    this.sampler = options.sampler ?? sampleProcessTree;
    this.maxProcessRows = Math.max(1, Math.trunc(options.maxProcessRows ?? DEFAULT_MAX_PROCESS_ROWS));
  }

  start(pid: number | undefined): void {
    if (!pid || !Number.isInteger(pid) || pid <= 0) return;
    if (this.activePid === pid && this.timer) return;
    this.stop();
    this.activePid = pid;
    void this.sampleNow();
    this.timer = setInterval(() => {
      void this.sampleNow();
    }, this.sampleIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.activePid = null;
  }

  snapshot(): ProcessTreeSamplerSnapshot {
    return {
      activePid: this.activePid,
      sampleIntervalMs: this.sampleIntervalMs,
      maxSamples: this.maxSamples,
      maxProcessRows: this.maxProcessRows,
      samples: [...this.samples],
      lastError: this.lastError,
    };
  }

  sampleNow(): Promise<ProcessTreeSample | null> {
    if (!this.activePid) return Promise.resolve(null);
    if (this.inFlight) return this.inFlight;
    const sampledPid = this.activePid;
    const operation = (async () => {
      try {
        const sample = await this.sampler(sampledPid, this.dateNow, {
          maxProcessRows: this.maxProcessRows,
        });
        this.lastError = null;
        if (sample && this.activePid === sampledPid) this.pushSample(sample);
        return sample;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        return null;
      }
    })();
    this.inFlight = operation;
    void operation.finally(() => {
      if (this.inFlight === operation) this.inFlight = null;
    });
    return operation;
  }

  private pushSample(sample: ProcessTreeSample): void {
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
  }
}

export async function sampleProcessTree(
  rootPid: number,
  dateNow: () => string = () => new Date().toISOString(),
  options: { maxProcessRows?: number; timeoutMs?: number } = {},
): Promise<ProcessTreeSample | null> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "$perf = @{}",
          "Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { if ($_.IDProcess -gt 0) { $perf[[int]$_.IDProcess] = [double]$_.PercentProcessorTime } }",
          "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 } | ForEach-Object {",
          "  $pidValue = [int]$_.ProcessId",
          "  $cpu = $perf[$pidValue]",
          "  if ($null -eq $cpu) { $cpu = 0 }",
          "  [PSCustomObject]@{ pid = $pidValue; ppid = [int]$_.ParentProcessId; cpuPercent = [double]$cpu; rssBytes = [double]$_.WorkingSetSize }",
          "} | ConvertTo-Json -Compress",
        ].join("; "),
      ],
      {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        timeout: options.timeoutMs ?? DEFAULT_SAMPLE_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    return summarizeProcessTree(rootPid, parseWindowsProcessRows(stdout), dateNow(), options.maxProcessRows);
  }
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,pcpu=,rss="], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: options.timeoutMs ?? DEFAULT_SAMPLE_TIMEOUT_MS,
    windowsHide: true,
  });
  return summarizeProcessTree(rootPid, parseUnixProcessRows(stdout), dateNow(), options.maxProcessRows);
}

export function parseWindowsProcessRows(output: string): ProcessTreeRow[] {
  if (!output.trim()) return [];
  try {
    const parsed = JSON.parse(output) as unknown;
    const records = Array.isArray(parsed) ? parsed : [parsed];
    return records
      .map((record) => {
        if (!record || typeof record !== "object" || Array.isArray(record)) return null;
        const row = record as Record<string, unknown>;
        return {
          pid: Number(row.pid),
          ppid: Number(row.ppid),
          cpuPercent: Number(row.cpuPercent),
          rssBytes: Number(row.rssBytes),
        };
      })
      .filter((row): row is ProcessTreeRow => Boolean(row))
      .filter(
        (row) =>
          Number.isInteger(row.pid) &&
          row.pid > 0 &&
          Number.isInteger(row.ppid) &&
          row.ppid >= 0 &&
          Number.isFinite(row.cpuPercent) &&
          Number.isFinite(row.rssBytes),
      );
  } catch {
    return [];
  }
}

export function parseUnixProcessRows(output: string): ProcessTreeRow[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pidRaw, ppidRaw, cpuRaw, rssRaw] = line.split(/\s+/);
      return {
        pid: Number(pidRaw),
        ppid: Number(ppidRaw),
        cpuPercent: Number(cpuRaw),
        rssBytes: Number(rssRaw) * 1024,
      };
    })
    .filter(
      (row) =>
        Number.isInteger(row.pid) &&
        row.pid > 0 &&
        Number.isInteger(row.ppid) &&
        row.ppid >= 0 &&
        Number.isFinite(row.cpuPercent) &&
        Number.isFinite(row.rssBytes),
    );
}

export function summarizeProcessTree(
  rootPid: number,
  rows: ProcessTreeRow[],
  sampledAt: string,
  maxProcessRows = DEFAULT_MAX_PROCESS_ROWS,
): ProcessTreeSample | null {
  const byParent = new Map<number, ProcessTreeRow[]>();
  for (const row of rows) {
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) return null;
  const processRows: ProcessTreeRow[] = [];
  const seen = new Set<number>();
  const visit = (row: ProcessTreeRow) => {
    if (seen.has(row.pid)) return;
    seen.add(row.pid);
    processRows.push(row);
    for (const child of byParent.get(row.pid) ?? []) visit(child);
  };
  visit(root);
  return {
    sampledAt,
    rootPid,
    processCount: processRows.length,
    cpuPercent: roundMetric(processRows.reduce((sum, row) => sum + row.cpuPercent, 0)),
    rssBytes: processRows.reduce((sum, row) => sum + row.rssBytes, 0),
    processes: [...processRows]
      .sort((left, right) => right.rssBytes - left.rssBytes || left.pid - right.pid)
      .slice(0, Math.max(1, maxProcessRows))
      .sort((left, right) => left.pid - right.pid),
  };
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}
