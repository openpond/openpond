import type { SubagentRef, SubagentRoleSettings, SubagentRun } from "@openpond/contracts";
import type { OpenPondSubagentToolResult } from "../../openpond/capability-tool-registry.js";

export function subagentToolResultFromRun(run: SubagentRun, nextStep: string): OpenPondSubagentToolResult {
  return {
    runId: run.id,
    childSessionId: run.childSessionId,
    roleId: run.roleId,
    status: run.status,
    modelRef: run.modelRef,
    isolationMode: run.isolationMode,
    toolPolicy: run.toolPolicy,
    background: run.background,
    peerMessages: run.peerMessages,
    progress: run.progress,
    report: run.report,
    nextStep,
  };
}

export function subagentRoleLabel(role: SubagentRoleSettings): string {
  return role.id.slice(0, 1).toUpperCase() + role.id.slice(1).replace(/[-_]+/g, " ");
}

export function uniqueSubagentRefs(values: readonly (SubagentRef | null | undefined)[]): SubagentRef[] {
  const seen = new Set<string>();
  const result: SubagentRef[] = [];
  for (const value of values) {
    if (!value) continue;
    const key = `${value.kind}:${value.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}
