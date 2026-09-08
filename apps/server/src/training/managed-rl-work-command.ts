import { mkdir, readFile } from "node:fs/promises";
import readline from "node:readline";

import { HarnessSourcePackageSchema } from "@openpond/harness";
import { z } from "zod";

import { executeManagedRlWorkTurn } from "./managed-rl-work-turn.js";

const RequestSchema = z.object({
  schemaVersion: z.literal("openpond.managedRlWorkRequest.v1"),
  workspaceDir: z.string().min(1),
  scratchDir: z.string().min(1),
  harnessSource: HarnessSourcePackageSchema,
  prompt: z.string().min(1),
  parentRunId: z.string().min(1),
  maxToolTurns: z.number().int().min(1).max(64),
  timeoutMs: z.number().int().min(1).max(3_600_000),
  policyRequest: z.record(z.string(), z.unknown()),
  sandboxId: z.string().min(1).optional(),
}).strict();

/** JSONL policy port for the same app-server used by hosted Work. The host owns
 * authentication; the policy-executing process never receives its credentials. */
export async function runManagedRlWorkCommand(requestPath: string): Promise<void> {
  const request = RequestSchema.parse(JSON.parse(await readFile(requestPath, "utf8")));
  const cancelled = new AbortController();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  let sequence = 0;
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", line => {
    try {
      const response = z.object({ id: z.number().int().nonnegative(), result: z.unknown() }).strict().parse(JSON.parse(line));
      const waiter = pending.get(response.id);
      if (!waiter) throw new Error("Unexpected Work policy response.");
      pending.delete(response.id);
      waiter.resolve(response.result);
    } catch {
      cancelled.abort(new Error("Invalid Work policy response transport."));
    }
  });
  lines.on("close", () => cancelled.abort(new Error("Work policy transport closed.")));
  const stop = () => cancelled.abort(new Error("Managed Work process interrupted."));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const signal = AbortSignal.any([cancelled.signal, AbortSignal.timeout(request.timeoutMs)]);
  function exchange(type: "policy_request" | "sandbox_request", body: unknown, requestSignal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = sequence++;
      const abort = () => { pending.delete(id); reject(requestSignal.reason); };
      requestSignal.addEventListener("abort", abort, { once: true });
      pending.set(id, {
        resolve(value) { requestSignal.removeEventListener("abort", abort); resolve(value); },
        reject(error) { requestSignal.removeEventListener("abort", abort); reject(error); },
      });
      if (requestSignal.aborted) { abort(); return; }
      process.stdout.write(`${JSON.stringify({ type, id, request: body })}\n`);
    });
  }
  try {
    await mkdir(request.scratchDir, { recursive: true });
    const result = await executeManagedRlWorkTurn({
      ...request,
      signal,
      ...(request.sandboxId ? { sandbox: {
        id: request.sandboxId,
        request: action => exchange("sandbox_request", action, signal),
      } } : {}),
      async complete(body, requestSignal) {
        return z.record(z.string(), z.unknown()).parse(await exchange("policy_request", body, requestSignal));
      },
    });
    process.stdout.write(`${JSON.stringify({ type: "result", schemaVersion: "openpond.managedRlWorkResult.v1", ...result })}\n`);
  } finally {
    lines.close();
    for (const waiter of pending.values()) waiter.reject(new Error("Work policy transport stopped."));
    pending.clear();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}
