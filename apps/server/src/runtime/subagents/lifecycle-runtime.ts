import {
  SubagentRunSchema,
  type RuntimeEvent,
  type Session,
  type SubagentLifecycleActionResponse,
  type SubagentRun,
} from "@openpond/contracts";
import { now, textFromUnknown } from "../../utils.js";

type AppendSubagentReceipt = (input: {
  parentSession: Session;
  parentTurnId?: string | null;
  run: SubagentRun;
  childSession?: Session | null;
  eventName: Extract<RuntimeEvent["name"], `subagent.${string}`>;
  status: RuntimeEvent["status"];
  output: string;
}) => Promise<void>;

export function createSubagentLifecycleRuntime(deps: {
  getRun(runId: string): Promise<SubagentRun | null>;
  upsertRun(run: SubagentRun): Promise<unknown>;
  getSession(sessionId: string): Promise<Session>;
  updateSession(sessionId: string, patch: Record<string, unknown>): Promise<Session>;
  appendSubagentReceipt: AppendSubagentReceipt;
}) {
  async function archiveSubagentChildSession(input: {
    parentSession: Session;
    parentTurnId?: string | null;
    run: SubagentRun;
    reason: string;
    policy: string;
  }): Promise<{ run: SubagentRun; sessionArchive: Record<string, unknown> }> {
    if (!input.run.childSessionId) {
      return { run: input.run, sessionArchive: { status: "missing_child_session" } };
    }
    let sessionArchive: Record<string, unknown>;
    try {
      const child = await deps.getSession(input.run.childSessionId);
      if (!child.archived) await deps.updateSession(child.id, { archived: true });
      sessionArchive = { status: child.archived ? "already_archived" : "archived", archivedAt: now() };
    } catch (error) {
      sessionArchive = {
        status: "failed",
        error: textFromUnknown(error) || "Failed to archive child conversation.",
      };
    }
    const current = (await deps.getRun(input.run.id)) ?? input.run;
    const updated = SubagentRunSchema.parse({
      ...current,
      metadata: {
        ...(current.metadata ?? {}),
        childSessionArchive: { ...sessionArchive, reason: input.reason, policy: input.policy },
      },
    });
    await deps.upsertRun(updated);
    await deps.appendSubagentReceipt({
      parentSession: input.parentSession,
      parentTurnId: input.parentTurnId,
      run: updated,
      eventName: "subagent.archived",
      status: sessionArchive.status === "failed" ? "failed" : "completed",
      output: sessionArchive.status === "failed"
        ? `Failed to archive ${updated.roleId} child conversation.`
        : `Archived ${updated.roleId} child conversation.`,
    });
    return { run: updated, sessionArchive };
  }

  function subagentLifecycleActionNextStep(
    action: SubagentLifecycleActionResponse["action"],
    workspaceCleanup: Record<string, unknown> | null,
    sessionArchive: Record<string, unknown> | null,
  ): string {
    if (action === "cleanup") {
      return workspaceCleanup
        ? "Child workspace cleanup finished."
        : "No child workspace cleanup was needed.";
    }
    if (action === "archive") {
      return sessionArchive
        ? "Child conversation archive finished."
        : "No child conversation was available to archive.";
    }
    return "Child workspace cleanup and conversation archive finished.";
  }

  return {
    archiveSubagentChildSession,
    subagentLifecycleActionNextStep,
  };
}
