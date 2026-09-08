import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import { SessionSchema, TurnSchema } from "@openpond/contracts";
import type { HarnessSourcePackage } from "@openpond/harness";
import { z } from "zod";

import { createOpenPondAppServer } from "../app-server-runtime.js";
import { parseManagedRlPolicyCompletion } from "./marketing-portfolio-rollout.js";
import { normalizeModelUsageTokens } from "../runtime/model-usage-normalization.js";
import type { AppServerSandboxRequest } from "../runtime/app-server-sandbox-tools.js";

/** Run one training attempt through the normal Work engine. The caller owns
 * task setup and grading; this adapter only supplies the learner policy port. */
export async function executeManagedRlWorkTurn(input: {
  workspaceDir: string;
  scratchDir: string;
  harnessSource: HarnessSourcePackage;
  prompt: string;
  parentRunId: string;
  maxToolTurns: number;
  policyRequest: Record<string, unknown>;
  signal: AbortSignal;
  sandbox?: {
    id: string;
    request: AppServerSandboxRequest;
  };
  complete(request: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>;
}) {
  input.signal.throwIfAborted();
  const storeDir = await mkdtemp(path.join(input.scratchDir, "work-attempt-"));
  const policyResults: Array<Record<string, unknown>> = [];
  let nextPolicyRequest = 0;
  let server: Awaited<ReturnType<typeof createOpenPondAppServer>> | null = null;
  let threadId: string | null = null;
  const interruptions: Array<Promise<unknown>> = [];
  const abort = () => {
    if (server && threadId) {
      interruptions.push(server.runtime.turnInterrupt({ threadId, reason: "Training attempt cancelled." }).catch(() => undefined));
    }
  };
  try {
    server = await createOpenPondAppServer({
      storeDir,
      workspaceDir: input.workspaceDir,
      capturedHarnessSource: input.harnessSource,
      ...(input.sandbox ? { sandboxRequest: async (action) => {
        input.signal.throwIfAborted();
        if (!("sandboxId" in action) || action.sandboxId !== input.sandbox!.id) {
          throw new Error("Training tools must target the assigned rollout sandbox.");
        }
        const result = await input.sandbox!.request(action);
        input.signal.throwIfAborted();
        return result;
      } } : {}),
      maxHostedWorkspaceToolRounds: input.maxToolTurns,
      streamOpenPondHostedChatTurn: async function* (request) {
        const signal = request.signal ? AbortSignal.any([input.signal, request.signal]) : input.signal;
        signal.throwIfAborted();
        const turnIndex = nextPolicyRequest++;
        if (turnIndex >= input.maxToolTurns) throw new Error("Work training policy request budget exhausted.");
        const result = await input.complete({
          ...input.policyRequest,
          messages: request.messages,
          tools: request.tools ?? [],
          toolChoice: request.toolChoice ?? "auto",
          turnIndex,
        }, signal);
        signal.throwIfAborted();
        const completion = parseManagedRlPolicyCompletion(result);
        policyResults[turnIndex] = result;
        const usage = normalizeModelUsageTokens(result.usage);
        if (usage.promptTokens !== null || usage.completionTokens !== null || usage.totalTokens !== null) {
          yield {
            type: "usage", raw: null,
            usage: {
              ...(usage.promptTokens !== null ? { prompt_tokens: usage.promptTokens } : {}),
              ...(usage.completionTokens !== null ? { completion_tokens: usage.completionTokens } : {}),
              ...(usage.totalTokens !== null ? { total_tokens: usage.totalTokens } : {}),
            },
          };
        }
        if (completion.content) yield { type: "text_delta", text: completion.content, raw: null };
        if (completion.toolCalls.length) yield {
          type: "tool_call_delta",
          toolCalls: completion.toolCalls.map(call => ({
            id: call.id, type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          })),
          raw: null,
        };
        yield { type: "finish", finishReason: completion.toolCalls.length ? "tool_calls" : "stop", raw: null };
      },
    });
    input.signal.throwIfAborted();
    const modelRef = { providerId: "openpond", modelId: "managed-training-policy" };
    const { thread } = z.object({ thread: SessionSchema }).parse(await server.runtime.threadStart({
      session: {
        provider: "openpond", modelRef, experience: "work",
        openPondCommandAccessMode: input.sandbox ? "disabled" : "full-access",
        ...(input.sandbox ? { workspaceKind: "sandbox", workspaceId: input.sandbox.id } : {}),
        cwd: input.workspaceDir, title: "Training attempt",
        metadata: {
          workspaceTarget: input.sandbox ? "hybrid" : "local", automatedTasksetWorkAttempt: true,
          parentModelRunId: input.parentRunId,
        },
      },
    }));
    threadId = thread.id;
    input.signal.addEventListener("abort", abort, { once: true });
    input.signal.throwIfAborted();
    const { turn } = z.object({ turn: TurnSchema }).parse(await server.runtime.turnStart({
      threadId, input: { prompt: input.prompt, modelRef },
    }));
    input.signal.throwIfAborted();
    if (turn.status !== "completed") throw new Error(`Work training turn ${turn.id} ended with status ${turn.status}.`);
    if (!policyResults.length) throw new Error("Work training turn produced no learner policy results.");
    const trace = await server.runtime.threadRead({ threadId });
    return { turn, trace, policyResults, policyResult: policyResults.at(-1)! };
  } finally {
    input.signal.removeEventListener("abort", abort);
    await Promise.all(interruptions);
    try { await server?.close(); }
    finally { await rm(storeDir, { recursive: true, force: true }); }
  }
}
