import { realpath } from "node:fs/promises";
import { z } from "zod";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import { ToolLearningLocalStore } from "openpond-sdk/tool-learning/node";
import { captureLocalToolBoundary } from "@openpond/local-server/tool-learning";
import { loadToolLearningCredential, saveToolLearningCredential, toolLearningHome, type ToolLearningOptions } from "./credentials";
import { configureLocalToolLearning, flushToolLearning } from "./delivery";
import { externalCaptureVersion, type ExternalCaptureClient } from "./external-client";

const ToolEvent = z.object({ cwd: z.string().min(1).max(4000), sessionId: z.string().min(1).max(200),
  event: z.enum(["start", "resume", "compact", "idle", "attempt", "observation", "failure"]),
  callId: z.string().max(200).optional(), tool: z.string().max(200).optional(), arguments: z.unknown().optional(),
  text: z.string().optional(), exitCode: z.number().int().nullable().optional() });
const Event = z.union([ToolEvent, z.object({ cwd: z.string().min(1).max(4000), event: z.literal("flush") })]);

/** Observer only: empty stdout, no transcript access, and no permission directives. */
export async function runExternalToolLearningHook(options: ToolLearningOptions, id: string, client: ExternalCaptureClient) {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length; if (bytes > 1048576) throw new Error("capture_input_limit"); chunks.push(buffer);
  }
  const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assertBoundedTaskJson(raw, 1048576);
  const event = Event.parse(raw);
  const home = toolLearningHome(options), saved = await loadToolLearningCredential(home, id), record = saved.value;
  if (record.prepared.registration.client !== client || !record.locallyEnabled || await realpath(event.cwd) !== record.workspaceRoot) return;
  const store = new ToolLearningLocalStore(home);
  try {
    configureLocalToolLearning(store, record, record.installation);
    // Version changes suspend collection before retaining any new tool boundary.
    if (await externalCaptureVersion(client) !== record.prepared.registration.clientVersion) {
      const suspended = { ...record, locallyEnabled: false };
      await saveToolLearningCredential(home, suspended, saved.revision);
      configureLocalToolLearning(store, suspended, record.installation);
      return;
    }
    if (event.event === "flush") {
      try { await flushToolLearning(home, store, record, AbortSignal.timeout(2000)); } catch { /* Startup retries retain the durable queue on transport failure. */ }
      return;
    }
    if (["start", "resume", "compact", "idle"].includes(event.event)) {
      if (event.event !== "idle") store.recordClientObservation(id, event.event as "start" | "resume" | "compact");
      try { await flushToolLearning(home, store, record, AbortSignal.timeout(2000)); } catch { /* Durable queue remains visible to doctor. */ }
      return;
    }
    store.recordClientObservation(id, event.event === "attempt" ? "pre_tool" : event.event === "failure" ? "failure" : "post_tool");
  } finally { store.close(); }
  if (!event.tool || !event.callId) return;
  const base = { client, installationId: id, workspaceRoot: event.cwd, sessionId: event.sessionId, callId: event.callId,
    tool: event.tool, clientVersion: record.prepared.registration.clientVersion };
  if (event.event === "attempt") {
    await captureLocalToolBoundary(home, { ...base, phase: "attempt", arguments: event.arguments }); return;
  }
  const exit = event.exitCode ?? null, failed = event.event === "failure" || (exit !== null && exit !== 0);
  await captureLocalToolBoundary(home, { ...base, phase: "observation", result: {
    outcome: failed ? "failed" : exit === 0 ? "succeeded" : "incomplete",
    execution: exit === null ? "unknown" : "executed", sideEffects: "unknown", text: event.text ?? "",
    exitCode: exit, classification: exit !== null && exit !== 0 ? "process_failure" : "unknown_failure",
  } });
}
