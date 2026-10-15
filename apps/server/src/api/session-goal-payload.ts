import { z } from "zod";
import { CodexAppServerClient } from "@openpond/codex-provider";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import { isCodexHistorySessionId, readCodexHistoryThreadPayload } from "../codex-history.js";
import { event } from "../utils.js";

const GoalPatchSchema = z.object({
  objective: z.string().trim().min(1).max(32_000).optional(),
  status: z.enum(["active", "paused"]).optional(),
  expectedObjective: z.string().min(1),
}).strict().refine(input => input.objective !== undefined || input.status !== undefined, "No goal change supplied.");

/** Mutate the provider's goal, never a second local goal store or a model prompt. */
export function createSessionGoalPayload(deps: {
  getSession: (id: string) => Promise<Session>;
  appendRuntimeEvent: (value: RuntimeEvent) => Promise<void>;
  createClient?: () => Pick<CodexAppServerClient, "getThreadGoal" | "setThreadGoal" | "stop">;
}) {
  const pending = new Map<string, Promise<unknown>>();
  return async (sessionId: string, payload: unknown) => {
    const patch = payload === undefined ? null : GoalPatchSchema.parse(payload);
    const previous = pending.get(sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const imported = isCodexHistorySessionId(sessionId);
      const session = imported
        ? (await readCodexHistoryThreadPayload(sessionId, { tail: true, maxEvents: 1 })).session
        : await deps.getSession(sessionId);
      if (session.provider !== "codex" || !session.codexThreadId) {
        throw new Error("This chat does not have a Codex goal.");
      }
      if (session.status === "closed") throw new Error("Reopen this chat before editing its goal.");
      const client = deps.createClient?.() ?? new CodexAppServerClient({
        binaryPath: process.env.CODEX_BINARY || "codex", experimentalApi: true,
      });
      try {
        const current = (await client.getThreadGoal(session.codexThreadId)).goal;
        if (!patch) return { goal: current, observedAt: new Date().toISOString() };
        if (!current) throw new Error("This goal has been removed. Reopen the chat to refresh its status.");
        if (current.objective !== patch.expectedObjective) {
          throw new Error("The goal changed while you were editing. Reopen the goal editor and try again.");
        }
        const result = await client.setThreadGoal(session.codexThreadId, {
          ...(patch.objective !== undefined ? { objective: patch.objective } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
        });
        const observedAt = new Date().toISOString();
        // Imported chats read provider history; managed chats use runtime events.
        if (!imported) await deps.appendRuntimeEvent(event({
          sessionId, name: "diagnostic", source: "provider", output: result.goal.objective,
          data: { kind: "thread_goal", provider: "codex", goal: result.goal },
        }));
        return { ...result, observedAt };
      } finally {
        await client.stop();
      }
    });
    pending.set(sessionId, operation);
    try { return await operation; }
    finally { if (pending.get(sessionId) === operation) pending.delete(sessionId); }
  };
}
