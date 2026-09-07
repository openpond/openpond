import { z } from "zod";
import { type ToolDeclaration, contentHash } from "@openpond/harness";
import { assertBoundedTaskJson } from "./task-schema.js";
import { createJavaScriptEnvironmentSession, JavaScriptEnvironmentActionError, type JavaScriptEnvironmentSnapshot } from "./javascript-environment.js";

const ToolCallSchema = z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(64), arguments: z.record(z.string(), z.unknown()) }).strict();
const PolicyTurnSchema = z.object({ text: z.string().max(262_144), toolCalls: z.array(ToolCallSchema).max(200) }).strict();
export type JavaScriptEnvironmentToolCall = z.infer<typeof ToolCallSchema>;
export type JavaScriptEnvironmentPolicyTurn = z.infer<typeof PolicyTurnSchema>;
export type JavaScriptEnvironmentPolicyMessage =
  | { role: "system" | "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: JavaScriptEnvironmentToolCall[] }
  | { role: "tool"; callId: string; name: string; observation: Record<string, unknown> };

export interface JavaScriptEnvironmentAttempt {
  schemaVersion: "openpond.javascriptEnvironmentAttempt.v1";
  taskId: string;
  status: "completed" | "budget_exhausted" | "cancelled" | "timed_out" | "policy_failure" | "environment_failure";
  output: string | null;
  snapshot: JavaScriptEnvironmentSnapshot | null;
  collected: boolean;
  environmentCleanupComplete: boolean;
  messages: JavaScriptEnvironmentPolicyMessage[];
  error: string | null;
  contentHash: string;
}

/** The policy receives observations, never source, initial state or evaluator
 * targets. Its final text cannot replace state recorded by the environment.
 * The policy adapter must honor signal and settle after its own cancellation. */
export async function runJavaScriptEnvironmentAttempt(input: Parameters<typeof createJavaScriptEnvironmentSession>[0] & {
  taskId: string;
  instructions: string;
  timeoutMs: number;
  policy: (input: { messages: JavaScriptEnvironmentPolicyMessage[]; tools: ToolDeclaration[]; signal: AbortSignal }) => Promise<JavaScriptEnvironmentPolicyTurn>;
}): Promise<JavaScriptEnvironmentAttempt> {
  if (!input.taskId || input.taskId.length > 500) throw new Error("environment_task_identity_invalid");
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 3_600_000) throw new Error("environment_attempt_timeout_invalid");
  assertBoundedTaskJson(input.instructions, 262_144);
  const taskId = input.taskId, instructions = input.instructions;
  const taskInput = structuredClone(input.input), policy = input.policy;
  const controller = new AbortController();
  const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("environment_attempt_timeout")); }, input.timeoutMs);
  timer.unref?.();
  let session: Awaited<ReturnType<typeof createJavaScriptEnvironmentSession>> | null = null;
  let snapshot: JavaScriptEnvironmentSnapshot | null = null;
  let status: JavaScriptEnvironmentAttempt["status"] = "environment_failure";
  let output: string | null = null, error: string | null = null;
  let collected = false, environmentCleanupComplete = false;
  const messages: JavaScriptEnvironmentPolicyMessage[] = [];
  let transcriptBytes = 0;
  const append = (message: JavaScriptEnvironmentPolicyMessage) => {
    transcriptBytes += new TextEncoder().encode(JSON.stringify(message)).byteLength;
    if (transcriptBytes > 4_194_304) { status = "budget_exhausted"; throw new Error("environment_transcript_budget_exhausted"); }
    messages.push(message);
  };
  const callIds = new Set<string>();
  try {
    session = await createJavaScriptEnvironmentSession({ ...input, input: taskInput, signal });
    append({ role: "system", text: instructions });
    append({ role: "user", text: JSON.stringify({ input: taskInput, observation: session.observation }) });
    for (let turn = 0; turn <= session.definition.maxSteps; turn++) {
      signal.throwIfAborted();
      let response: JavaScriptEnvironmentPolicyTurn;
      try {
        const value = await policy({ messages: structuredClone(messages), tools: structuredClone(session.definition.tools), signal });
        assertBoundedTaskJson(value, 1_048_576);
        response = structuredClone(PolicyTurnSchema.parse(value));
        for (const call of response.toolCalls) {
          if (callIds.has(call.id)) throw new Error("environment_duplicate_tool_call_identity");
          callIds.add(call.id);
        }
      } catch (cause) {
        if (signal.aborted) throw cause;
        status = "policy_failure";
        throw cause;
      }
      signal.throwIfAborted();
      append({ role: "assistant", ...response });
      if (!response.toolCalls.length) {
        output = response.text;
        await session.collect();
        snapshot = session.snapshot();
        collected = true;
        status = "completed";
        break;
      }
      for (const call of response.toolCalls) {
        let observation: Record<string, unknown>;
        try { observation = await session.step({ name: call.name, arguments: call.arguments }); }
        catch (cause) {
          if (!(cause instanceof JavaScriptEnvironmentActionError)) throw cause;
          if (cause.code === "step_budget_exhausted") { status = "budget_exhausted"; break; }
          observation = { error: cause.code };
        }
        append({ role: "tool", callId: call.id, name: call.name, observation });
      }
      if (status === "budget_exhausted") break;
      if (turn === session.definition.maxSteps) status = "budget_exhausted";
    }
    snapshot ??= session.snapshot();
  } catch (cause) {
    if (signal.aborted) status = timedOut ? "timed_out" : "cancelled";
    error = cause instanceof Error ? cause.message : "environment_attempt_failed";
    snapshot ??= session?.snapshot() ?? null;
  } finally {
    clearTimeout(timer);
    if (session) {
      try { await session.destroy(); environmentCleanupComplete = true; }
      catch (cause) { status = "environment_failure"; error = cause instanceof Error ? cause.message : "environment_cleanup_failed"; }
    }
  }
  const result = { schemaVersion: "openpond.javascriptEnvironmentAttempt.v1" as const, taskId, status, output, snapshot, collected, environmentCleanupComplete, messages, error };
  return { ...result, contentHash: contentHash(result) };
}
