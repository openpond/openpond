import {
  type AppPreferences,
  type RuntimeEvent,
  type Session,
  type SubagentDelegationMode,
  type SubagentRoleSettings,
  type SubagentRun,
} from "@openpond/contracts";
import { recordFromUnknown, stringFromRecord } from "../turns/value-utils.js";

export function subagentRunAccepted(run: SubagentRun): boolean {
  return run.status === "completed";
}

export function subagentRunDismissed(run: SubagentRun): boolean {
  return run.status === "failed" || run.status === "cancelled";
}

export function subagentRunResolvedForGoal(run: SubagentRun): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "cancelled";
}

export function assertSubagentRunAccessible(session: Session, run: SubagentRun): void {
  if (
    run.parentSessionId === session.id ||
    run.childSessionId === session.id ||
    (session.parentSessionId && session.parentSessionId === run.parentSessionId)
  ) return;
  throw new Error(`Subagent run ${run.id} is not linked to the current conversation.`);
}

export function subagentChildSystemContext(input: {
  role: SubagentRoleSettings;
  objective: string;
  parentSession: Session;
  contextPack: string | null;
}): string {
  return [
    `You are an OpenPond ${input.role.id} child agent in your own conversation.`,
    "Work on the assignment below. Do not start additional child agents.",
    `Tool policy: ${input.role.toolPolicy}. Isolation: ${input.role.isolationMode}.`,
    `Parent chat: ${input.parentSession.title} (${input.parentSession.id}).`,
    "Use openpond_subagent_send_message only for useful coordination while you work.",
    "Your final assistant answer is delivered to the parent automatically, so do not send a duplicate final handoff.",
    "",
    "Assignment:",
    input.objective,
    input.contextPack ? ["", "Context:", input.contextPack].join("\n") : "",
    "",
    "When done, return a compact result with four short sections: Result, Changed files, Validation, and Blockers. The parent decides what happens next.",
    "Avoid overlapping heavyweight repository-wide checks.",
  ].filter(Boolean).join("\n");
}

export function subagentChildPrompt(input: {
  objective: string;
  contextPack: string | null;
}): string {
  return [
    input.objective,
    input.contextPack ? ["Context:", input.contextPack].join("\n") : null,
  ].filter(Boolean).join("\n\n");
}

export type SubagentDelegationResolution = {
  mode: SubagentDelegationMode;
  source: "session_override" | "global_default";
};

export function resolveSubagentDelegation(
  session: Session,
  preferences: AppPreferences | null,
): SubagentDelegationResolution | null {
  if (session.subagentRunId || !preferences?.subagents.enabled) return null;
  return session.subagentDelegationMode
    ? { mode: session.subagentDelegationMode, source: "session_override" }
    : { mode: preferences.subagents.delegationMode, source: "global_default" };
}

function subagentDelegationInstruction(resolution: SubagentDelegationResolution): string {
  const behavior = resolution.mode === "manual"
    ? "Start child agents only when the user explicitly requests delegation."
    : resolution.mode === "proactive"
      ? "Use child agents when parallel work would materially improve speed or quality."
      : "Delegate bounded work when parallelism or a fresh context is valuable; keep small linear work in the parent.";
  return [
    `Subagent delegation mode: ${resolution.mode}. ${behavior}`,
    "Each child has its own conversation. Its final answer returns automatically.",
    "Do not poll child status, run sleep commands, or interrupt a child merely for progress. Use join once when you truly need to wait; it blocks briefly. Otherwise end the turn and let the automatic completion continue you.",
    "Reserve interrupt-priority messages for genuinely changed urgent instructions, never status requests.",
    "Before starting a child, reuse an existing conversation for that role with openpond_subagent_followup when the work is a continuation, correction, or re-review.",
    "Do not start a duplicate role conversation solely because the goal entered a new phase.",
    "A reviewer is an ordinary child role, not a required lifecycle stage.",
    "Run at most one repository-wide typecheck, build, or full test suite at a time.",
    "Explicit user delegation instructions take priority over this default.",
  ].join("\n");
}

export function subagentSystemContextForSession(
  session: Session,
  delegation: SubagentDelegationResolution | null,
): string | null {
  if (!session.subagentRunId) return delegation ? subagentDelegationInstruction(delegation) : null;
  const subagent = recordFromUnknown(recordFromUnknown(session.metadata)?.subagent);
  const systemContext = typeof subagent?.systemContext === "string" ? subagent.systemContext.trim() : "";
  return systemContext || null;
}

export function activeThreadGoalId(events: RuntimeEvent[], sessionId: string): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index];
    if (item.sessionId !== sessionId || item.name !== "diagnostic") continue;
    const data = item.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const record = data as Record<string, unknown>;
    if (record.kind === "thread_goal_cleared") return null;
    if (record.kind !== "thread_goal") continue;
    const goal = record.goal;
    if (!goal || typeof goal !== "object" || Array.isArray(goal)) continue;
    const goalRecord = goal as Record<string, unknown>;
    const status = stringFromRecord(goalRecord, "status")?.toLowerCase() ?? "active";
    if (["completed", "complete", "failed", "stopped"].includes(status)) return null;
    return stringFromRecord(goalRecord, "id");
  }
  return null;
}
