import path from "node:path";

import { WORK_OUTPUT_CONTENT_TYPES } from "@openpond/contracts";

import type { NativeModelToolResult } from "../openpond/native-tool-calls.js";
import type { TasksetWorkModelDelta } from "./taskset-work-attempt-types.js";

export function listedWorkOutputPaths(result: NativeModelToolResult): string[] {
  const records: Record<string, unknown>[] = [];
  if (result.data && typeof result.data === "object" && !Array.isArray(result.data)) {
    records.push(result.data as Record<string, unknown>);
  }
  try {
    const parsed = JSON.parse(result.contentText) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const data = (parsed as Record<string, unknown>).data;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        records.push(data as Record<string, unknown>);
      }
    }
  } catch {
    // A failed or non-JSON list result simply exposes no output paths.
  }
  return [...new Set(records.flatMap((record) => {
    const files = Array.isArray(record.files) ? record.files : [];
    return files.flatMap((value) => {
      const candidate = typeof value === "string"
        ? value
        : value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>).path
          : null;
      if (typeof candidate !== "string") return [];
      const normalized = path.posix.normalize(candidate.replaceAll("\\", "/"));
      if (normalized.startsWith("outputs/")) return [normalized.slice("outputs/".length)];
      return normalized.startsWith("/") || normalized.startsWith("../") ? [] : [normalized];
    });
  }))];
}

export function uniqueCompatibleOutputPath(input: {
  availableOutputs: string[];
  claimedSourcePaths: Set<string>;
  mediaType: string;
}): string | null {
  const compatible = input.availableOutputs.filter((candidate) => {
    if (input.claimedSourcePaths.has(candidate)) return false;
    const extension = path.posix.extname(candidate).toLowerCase();
    return WORK_OUTPUT_CONTENT_TYPES[extension] === input.mediaType;
  });
  return compatible.length === 1 ? compatible[0]! : null;
}

export function boundedRequestSignal(
  parent: AbortSignal,
  timeoutMs: number | null,
): { signal: AbortSignal; dispose(): void } {
  if (timeoutMs === null) return { signal: parent, dispose() {} };
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(
    parent.reason ?? new Error("The Work evaluation was cancelled."),
  );
  if (parent.aborted) abortFromParent();
  else parent.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error(`Work model request exceeded ${timeoutMs} ms.`));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", abortFromParent);
    },
  };
}

export async function nextTasksetWorkModelDelta(
  iterator: AsyncIterator<TasksetWorkModelDelta>,
  signal: AbortSignal,
): Promise<IteratorResult<TasksetWorkModelDelta>> {
  throwIfAborted(signal);
  return await new Promise<IteratorResult<TasksetWorkModelDelta>>((resolve, reject) => {
    const rejectForAbort = () => reject(
      signal.reason instanceof Error
        ? signal.reason
        : new Error("The Work model request was cancelled."),
    );
    signal.addEventListener("abort", rejectForAbort, { once: true });
    void iterator.next().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", rejectForAbort);
    });
  });
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("The Work evaluation was cancelled.");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function elapsedMilliseconds(startedAt: string, completedAt: string): number {
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}
