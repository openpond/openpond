import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { Taskset } from "@openpond/contracts";
import { assertTasksetMetricSource } from "@openpond/evals/metrics";
import type { TasksetRelease } from "@openpond/evals/tasksets";
import { contentHash, sha256 } from "@openpond/harness";
import { tasksetPackageDirectoryId } from "./taskset-package-path.js";

/** Capture once at run admission. Later edits cannot change a running metric,
 * and invalid or missing module bytes fail before the first model call. */
export async function captureTasksetMetricSource(taskset: Taskset, home?: string, signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  const aggregator = taskset.metrics?.customAggregator;
  if (!aggregator) return undefined;
  if (!home) throw new Error("Taskset metric execution requires its package storage directory.");
  const packageDirectory = path.join(home, "training", "tasksets", tasksetPackageDirectoryId(taskset));
  const packageStatus = await lstat(packageDirectory);
  if (!packageStatus.isDirectory() || packageStatus.isSymbolicLink()) throw new Error("Taskset metric package must be a regular directory.");
  const root = await realpath(packageDirectory);
  const location = path.resolve(root, aggregator.module);
  if (!location.startsWith(`${root}${path.sep}`) || await realpath(location) !== location) throw new Error("Taskset metric module must be a regular file inside its pinned package.");
  const handle = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const status = await handle.stat();
    if (!status.isFile() || status.size > 524_288) throw new Error("Taskset metric module must be a bounded regular file.");
    const bytes = Buffer.alloc(status.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const next = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!next.bytesRead) throw new Error("Taskset metric module changed during capture.");
      offset += next.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead || sha256(bytes) !== aggregator.contentHash) throw new Error("Taskset metric module differs from its pinned content hash.");
    signal?.throwIfAborted();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally { await handle.close(); }
}

export function assertLocalTasksetMetric(taskset: Taskset, release: TasksetRelease, source?: string): void {
  if (contentHash(taskset.metrics ?? null) !== contentHash(release.metrics ?? null)) throw new Error("Local Taskset metric policy differs from the admitted portable release.");
  assertTasksetMetricSource(release, source);
}
