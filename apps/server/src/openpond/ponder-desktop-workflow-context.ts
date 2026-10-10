import { PonderLocalOwnerSchema } from "./ponder-local-scope.js";
import { PonderDesktopInputSchema } from "../store/ponder-desktop-input.js";
import type { TaskInput, PonderDesktopOperation, Session } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import type { createPonderDesktopSourceStore } from "./ponder-desktop-source.js";

export function desktopWorkflow(input: TaskInput | null | undefined) {
  if (input?.senderKind !== "ponder") return null;
  return PonderDesktopInputSchema.parse(input.payload.ponderDesktop).operation.workflow ?? null;
}

export function desktopWorkflowPrompt(input: TaskInput | null | undefined) {
  const workflow = desktopWorkflow(input);
  if (!workflow) return "";
  const context = `\n\nDesktop workflow ${workflow.title} (${workflow.handoffId}). Your peer implementer is task ${workflow.prerequisiteSessionId}; its exact assignment input is ponder-input:${workflow.prerequisiteOperationId}. Use the task inbox tools for attributed communication.`;
  return (
    context +
    (workflow.role === "preparation"
      ? " You are preparing an independent review. Send a useful checklist to the implementer, then use openpond_wait_for_task with that task ID, exact input ID, and timeoutMs 3600000. A message wake requires rechecking the exact assignment; only a completed assignment ends the preparation successfully. Waiting suspends execution; do not poll. After the assignment finishes, conclude this preparation turn. Do not review or edit the live checkout. The orchestrator will send the actual review assignment in this same session only after the committed result satisfies the criteria and its source is retained. A failure or timeout does not authorize review."
      : ` Review only source ${workflow.source?.manifestHash ?? "unavailable"} through openpond_read_workflow_source. The diff and changed files are retained; unchanged context comes from the exact Git base commit. Current checkout bytes may differ. This review runs read-only. Report findings with precise paths and source evidence using openpond_report_review, then wait on its exact input receipt if you need the reporting-only acknowledgment. Do not edit, commit, deploy, or initiate another coding assignment. Report whether the requested criteria hold and what validation you could establish.`)
  );
}

export async function assertDesktopWorkflowSource(
  operation: PonderDesktopOperation,
  session: Session,
  store: Partial<Pick<SqliteStore, "getPonderDesktopResult">>,
  sourceStore: ReturnType<typeof createPonderDesktopSourceStore>,
) {
  const workflow = operation.workflow;
  if (!workflow || workflow.role !== "successor") return;
  const owner = PonderLocalOwnerSchema.parse(session.metadata?.ponderLocalOwner);
  if (
    (["installationId", "profileId", "ownerUserId", "teamId"] as const).some(
      (key) => owner[key] !== operation.origin.scope[key],
    )
  )
    throw new Error("ponder_desktop_review_owner_changed");
  const source = workflow.source;
  if (
    !source ||
    source.sessionId !== workflow.prerequisiteSessionId ||
    source.workspaceId !== operation.target.workspaceId ||
    source.workspaceId !== (session.localProjectId ?? session.workspaceId ?? session.cwd)
  )
    throw new Error("ponder_desktop_review_source_missing_or_workspace_changed");
  const result = await store.getPonderDesktopResult?.(
    workflow.prerequisiteOperationId,
    source.turnId,
  );
  if (result?.outcome !== "completed" || JSON.stringify(result.source) !== JSON.stringify(source))
    throw new Error("ponder_desktop_review_source_not_committed");
  await sourceStore.verify(source);
}
