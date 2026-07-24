import { spawn } from "node:child_process";

import type { WorkerCatalogEntry } from "@openpond/contracts";

export type WorkerImagePreparationState = {
  imageRef: string;
  digest: string;
  expectedBytes: number;
  diskImpactBytes: number;
  cached: boolean;
  state:
    | "ready"
    | "required"
    | "downloading"
    | "verifying"
    | "cancelled"
    | "failed";
  progress: number | null;
  message: string;
};

export interface WorkerImageCommandRunner {
  run(input: {
    command: string;
    args: string[];
    signal?: AbortSignal;
    onOutput?(line: string): void;
  }): Promise<{ code: number; stdout: string; stderr: string }>;
}

export class SpawnWorkerImageCommandRunner
  implements WorkerImageCommandRunner
{
  async run(input: {
    command: string;
    args: string[];
    signal?: AbortSignal;
    onOutput?(line: string): void;
  }): Promise<{ code: number; stdout: string; stderr: string }> {
    const child = spawn(input.command, input.args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal: input.signal,
    });
    let stdout = "";
    let stderr = "";
    const consume = (chunk: Buffer, stream: "stdout" | "stderr") => {
      const text = chunk.toString();
      if (stream === "stdout") stdout += text;
      else stderr += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) input.onOutput?.(line.trim());
      }
    };
    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => {
        resolve(exitCode ?? (signal === "SIGTERM" ? 130 : 1));
      });
    });
    return { code, stdout, stderr };
  }
}

export class WorkerImageDistribution {
  constructor(
    private readonly runner: WorkerImageCommandRunner,
    private readonly runtime: "docker" | "podman" = "docker",
  ) {}

  async inspect(entry: WorkerCatalogEntry): Promise<WorkerImagePreparationState> {
    const imageRef = immutableImageRef(entry);
    const result = await this.runner.run({
      command: this.runtime,
      args: [
        "image",
        "inspect",
        imageRef,
        "--format",
        "{{json .RepoDigests}}\t{{.Size}}",
      ],
    });
    if (result.code !== 0) return state(entry, "required", false, null);
    const [repoDigestsJson, sizeText] = result.stdout.trim().split("\t");
    let repoDigests: string[] = [];
    try {
      const parsed = JSON.parse(repoDigestsJson ?? "[]") as unknown;
      if (Array.isArray(parsed)) {
        repoDigests = parsed.filter(
          (candidate): candidate is string => typeof candidate === "string",
        );
      }
    } catch {
      return state(entry, "failed", false, null, "Image metadata is invalid.");
    }
    if (!repoDigests.some((candidate) => candidate.endsWith(`@${entry.image.digest}`))) {
      return state(
        entry,
        "failed",
        false,
        null,
        "Cached worker image digest does not match the signed catalog.",
      );
    }
    const size = Number.parseInt(sizeText ?? "", 10);
    return state(
      entry,
      "ready",
      true,
      1,
      Number.isSafeInteger(size)
        ? `Verified ${formatBytes(size)} on disk.`
        : "Verified immutable worker image.",
    );
  }

  async prepare(input: {
    entry: WorkerCatalogEntry;
    signal?: AbortSignal;
    onProgress?(state: WorkerImagePreparationState): void;
  }): Promise<WorkerImagePreparationState> {
    const existing = await this.inspect(input.entry);
    if (existing.state === "ready") {
      input.onProgress?.(existing);
      return existing;
    }
    if (input.signal?.aborted) {
      const cancelled = state(input.entry, "cancelled", false, null);
      input.onProgress?.(cancelled);
      return cancelled;
    }
    let observedLayers = 0;
    const downloading = state(input.entry, "downloading", false, 0);
    input.onProgress?.(downloading);
    try {
      const result = await this.runner.run({
        command: this.runtime,
        args: ["pull", immutableImageRef(input.entry)],
        signal: input.signal,
        onOutput: (line) => {
          if (
            /Downloading|Pulling fs layer|Download complete|Pull complete/i.test(
              line,
            )
          ) {
            observedLayers += 1;
            input.onProgress?.(
              state(
                input.entry,
                "downloading",
                false,
                Math.min(0.95, observedLayers / (observedLayers + 3)),
                line,
              ),
            );
          }
        },
      });
      if (result.code !== 0) {
        const cancelled = input.signal?.aborted || result.code === 130;
        const failed = state(
          input.entry,
          cancelled ? "cancelled" : "failed",
          false,
          null,
          cancelled
            ? "Worker image download was cancelled."
            : result.stderr.trim() || "Worker image download failed.",
        );
        input.onProgress?.(failed);
        if (!cancelled) throw new Error(failed.message);
        return failed;
      }
      input.onProgress?.(state(input.entry, "verifying", false, 0.98));
      const verified = await this.inspect(input.entry);
      if (verified.state !== "ready") {
        throw new Error(
          "Pulled worker image did not verify against the signed digest.",
        );
      }
      input.onProgress?.(verified);
      return verified;
    } catch (error) {
      if (input.signal?.aborted) {
        const cancelled = state(input.entry, "cancelled", false, null);
        input.onProgress?.(cancelled);
        return cancelled;
      }
      const failed = state(
        input.entry,
        "failed",
        false,
        null,
        error instanceof Error ? error.message : String(error),
      );
      input.onProgress?.(failed);
      throw error;
    }
  }
}

export function assertWorkerCompatibility(input: {
  entry: WorkerCatalogEntry;
  openpondRelease: string;
  workerProtocolVersion: string;
  accelerator: string;
  architecture?: string | null;
}): void {
  if (input.entry.workerProtocolVersion !== input.workerProtocolVersion) {
    throw new Error("Worker protocol is incompatible with this OpenPond release.");
  }
  if (!releaseRangeIncludes(input.entry.openpondReleaseRange, input.openpondRelease)) {
    throw new Error("Worker image is incompatible with this OpenPond release.");
  }
  if (input.entry.runtime.accelerator !== input.accelerator) {
    throw new Error(
      `Worker requires ${input.entry.runtime.accelerator}, not ${input.accelerator}.`,
    );
  }
  if (
    input.architecture &&
    input.entry.runtime.architectures.length > 0 &&
    !input.entry.runtime.architectures.includes(input.architecture)
  ) {
    throw new Error(
      `Worker image does not support accelerator architecture ${input.architecture}.`,
    );
  }
}

function immutableImageRef(entry: WorkerCatalogEntry): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(entry.image.digest)) {
    throw new Error("Worker image is not pinned by an immutable digest.");
  }
  return `${entry.image.repository}@${entry.image.digest}`;
}

function state(
  entry: WorkerCatalogEntry,
  preparationState: WorkerImagePreparationState["state"],
  cached: boolean,
  progress: number | null,
  message?: string,
): WorkerImagePreparationState {
  return {
    imageRef: immutableImageRef(entry),
    digest: entry.image.digest,
    expectedBytes: entry.image.sizeBytes,
    diskImpactBytes: entry.image.sizeBytes,
    cached,
    state: preparationState,
    progress,
    message:
      message ??
      (preparationState === "ready"
        ? "Verified immutable worker image."
        : preparationState === "required"
          ? `${formatBytes(entry.image.sizeBytes)} download required.`
          : preparationState),
  };
}

function releaseRangeIncludes(range: string, version: string): boolean {
  const match = /^>=([0-9]+\.[0-9]+\.[0-9]+) <([0-9]+\.[0-9]+\.[0-9]+)$/.exec(
    range,
  );
  if (!match) return false;
  return compareVersion(version, match[1]!) >= 0 && compareVersion(version, match[2]!) < 0;
}

function compareVersion(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = "B";
  for (const candidate of units) {
    value /= 1024;
    unit = candidate;
    if (value < 1024) break;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}
