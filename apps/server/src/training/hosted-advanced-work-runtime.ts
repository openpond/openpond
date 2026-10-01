import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  SessionSchema,
  WorkspaceToolResultSchema,
  type Session,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import type { TasksetWorkAttemptRuntime } from "./taskset-work-attempt-types.js";
import type { createHostedAdvancedModelBridge } from "./hosted-advanced-model-bridge.js";
/** Foreground tools go to the actual hosted compute owner. Private evaluator
 * files and the model socket remain in the parent, outside every guest mount. */
export function createHostedAdvancedWorkRuntime(deps: {
  store: SqliteStore;
  bridge: ReturnType<typeof createHostedAdvancedModelBridge>;
  teamId: string;
  actorId: string;
  hostedTurnId: string;
  modelRunId: string;
  profileRef: NonNullable<Session["currentProfile"]>;
}): TasksetWorkAttemptRuntime {
  async function read(id: string) {
    const session = await deps.store.getSession(id);
    if (
      !session ||
      session.cloudTeamId !== deps.teamId ||
      session.metadata?.hostedAdvancedTurnId !== deps.hostedTurnId ||
      session.metadata?.parentModelRunId !== deps.modelRunId
    )
      throw new Error("The actual hosted advanced case owner changed.");
    return session;
  }
  async function tool(sessionId: string, payload: unknown, turnId?: string) {
    const session = await read(sessionId),
      action = z
        .object({ action: z.string() })
        .passthrough()
        .parse(payload).action;
    return WorkspaceToolResultSchema.parse(
      await deps.bridge.compute(
        { session, payload, turnId: turnId ?? null },
        action === "sandbox_stop" || action === "sandbox_receipts",
      ),
    );
  }
  return {
    createSession: async (raw) => {
      await deps.bridge.authorize();
      const input = SessionSchema.partial().parse(raw),
        now = new Date().toISOString();
      if (input.metadata?.parentModelRunId !== deps.modelRunId)
        throw new Error(
          "The foreground case belongs to another actual advanced Run.",
        );
      const session = SessionSchema.parse({
        ...input,
        id: `hosted-advanced-case-${randomUUID()}`,
        provider: "openpond",
        currentProfile: deps.profileRef,
        cloudTeamId: deps.teamId,
        cwd: null,
        codexThreadId: null,
        appId: null,
        appName: null,
        createdAt: now,
        updatedAt: now,
        status: "active",
        pinned: false,
        archived: false,
        order: 0,
        hiddenFromDefaultSidebar: true,
        title: input.title ?? "Advanced hosted evaluation case",
        metadata: {
          ...input.metadata,
          source: "hosted-advanced-evaluation",
          hostedAdvancedTurnId: deps.hostedTurnId,
          actorId: deps.actorId,
          workspaceTarget: "hosted",
          benchmarkRuntime: "hosted_managed_work",
        },
      });
      await deps.store.insertSessionAtFront(session);
      await deps.bridge.authorize();
      return session;
    },
    getSession: read,
    runtimeEventsForSession: (id) => deps.store.runtimeEventsForSession(id),
    executeWorkspaceTool: (id, payload, options) =>
      tool(id, payload, options?.turnId),
    settleCostEvidence: (id, options) =>
      tool(id, { action: "sandbox_receipts", args: {} }, options?.turnId),
  };
}
