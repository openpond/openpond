import { useState, type ReactNode } from "react";
import {
  createImproveActionShapeFromMetadata,
  type CreateImproveRun,
  type SubagentLifecycleAction,
  type SubagentRun,
} from "@openpond/contracts";
import type { GoalRuntimeStatus } from "../../lib/goal-runtime";
import type { SubagentFinalResultSummary, SubagentRuntimeStatus } from "../../lib/subagent-runtime";
import { CircleAlert, FileText } from "../icons";
import { useErrorToast } from "../../app/AppToastContext";

export type GoalDetailsCreateRuntime = {
  run: CreateImproveRun;
};

export type GoalDetailsViewProps = {
  createRuntime: GoalDetailsCreateRuntime | null;
  goalRuntime: GoalRuntimeStatus | null;
  subagentRuntime?: SubagentRuntimeStatus | null;
  onRunSubagentLifecycleAction?: (input: { runId: string; action: SubagentLifecycleAction }) => Promise<void>;
};

export function GoalDetailsView({
  createRuntime,
  goalRuntime,
  subagentRuntime = null,
  onRunSubagentLifecycleAction,
}: GoalDetailsViewProps) {
  const title = createRuntime ? "Create/Improve Details" : "Goal Details";
  const stateLabel = createRuntime
    ? createStateLabel(createRuntime.run.state)
    : subagentRuntime?.activeCount
      ? subagentRuntime.label
      : goalRuntime?.actionLabel ?? "No active goal";

  return (
    <div className="goal-details-view" aria-label={title}>
      <div className="goal-details-header">
        <div className="goal-details-title">
          <FileText size={15} aria-hidden="true" />
          <span>{title}</span>
        </div>
        <span className={`goal-details-state ${createStateTone(createRuntime?.run.state ?? null)}`}>
          {stateLabel}
        </span>
      </div>
      <div className="goal-details-body">
        {createRuntime ? (
          <CreateDetails runtime={createRuntime} />
        ) : goalRuntime || subagentRuntime ? (
          <GoalRuntimeDetails
            goalRuntime={goalRuntime}
            subagentRuntime={subagentRuntime}
            onRunSubagentLifecycleAction={onRunSubagentLifecycleAction}
          />
        ) : (
          <EmptyDetails />
        )}
      </div>
    </div>
  );
}

function CreateDetails({ runtime }: { runtime: GoalDetailsCreateRuntime }) {
  const run = runtime.run;
  const plan = run.plan;
  const actionShape =
    createImproveActionShapeFromMetadata(plan?.metadata) ??
    createImproveActionShapeFromMetadata(run.metadata);
  const questions = run.questions;
  const pendingQuestions = questions.filter((question) => question.status === "pending");
  const sourceRefs = run.sourceRefs;
  const checkRefs = run.checkRefs;
  const state = run.state;
  const targetAction = run.target.kind === "agent" ? run.target.defaultActionKey : null;

  return (
    <>
      <DetailSection title="Current Work">
        <DetailGrid
          rows={[
            ["State", createStateLabel(state)],
            ["Operation", run.operation],
            ["Target", createStateLabel(run.target.kind)],
            ["Name", run.target.displayName ?? run.target.id ?? "Pending"],
            ["Target ID", run.target.id ?? "Pending"],
            ["Default action", targetAction ?? plan?.defaultChatAction.key ?? "Pending"],
            ["Adapter", createStateLabel(run.adapter.kind)],
            ["Run", run.id],
            ["Revision", String(run.revision)],
          ]}
        />
      </DetailSection>

      <DetailSection title="Plan">
        {plan ? (
          <>
            <p className="goal-details-summary">{plan.summary}</p>
            <DetailGrid
              rows={[
                ["Objective", plan.objective],
                ["Context", plan.capturedContextSummary],
                ["Status", createStateLabel(plan.status)],
                ["Plan ID", plan.id],
                ["Run ID", plan.runId],
                ["Approval", plan.approvalId ?? "Pending"],
                ["Approved", plan.approvedAt ?? "Not approved"],
              ]}
            />
          </>
        ) : pendingQuestions.length ? (
          <p className="goal-details-summary">Waiting for answers before the model finalizes the Create plan.</p>
        ) : (
          <p className="goal-details-summary">The model is preparing the Create plan.</p>
        )}
      </DetailSection>

      {actionShape ? (
        <DetailSection title="Action Shape">
          <DetailGrid
            rows={[
              ["Mode", actionShape.label],
              ["Default action", actionShape.defaultActionKey ?? "None"],
              ["Direct action", actionShape.directActionHint ?? "None planned"],
              ["Artifacts", actionShape.artifactPolicy],
            ]}
          />
          <p className="goal-details-note">{actionShape.detail}</p>
        </DetailSection>
      ) : null}

      {questions.length ? (
        <DetailSection title="Questions">
          <div className="goal-details-list">
            {questions.map((question) => (
              <article className="goal-details-list-item" key={question.id}>
                <div>
                  <strong>{question.title}</strong>
                  <span className={`goal-details-inline-state ${question.status}`}>{createStateLabel(question.status)}</span>
                </div>
                <p>{question.prompt}</p>
                {question.answer ? (
                  <small>Answer: {question.answer.label ?? question.answer.value}</small>
                ) : question.options.length ? (
                  <small>Options: {question.options.map((option) => option.label).join(", ")}</small>
                ) : null}
              </article>
            ))}
          </div>
        </DetailSection>
      ) : null}

      {plan?.requirements.length ? (
        <DetailSection title="Setup Requirements">
          <div className="goal-details-list">
            {plan.requirements.map((requirement) => (
              <article className="goal-details-list-item" key={`${requirement.kind}:${requirement.name}`}>
                <div>
                  <strong>{requirement.name}</strong>
                  <span className={`goal-details-inline-state ${requirement.status}`}>
                    {createStateLabel(requirement.status)}
                  </span>
                </div>
                <small>
                  {createStateLabel(requirement.kind)}
                  {requirement.detail ? `: ${requirement.detail}` : ""}
                </small>
              </article>
            ))}
          </div>
        </DetailSection>
      ) : null}

      {plan?.sourcePlan.length ? (
        <DetailSection title="Source Plan">
          <RefList
            refs={plan.sourcePlan.map((item) => ({
              id: `${item.operation}:${item.path}`,
              primary: item.path,
              secondary: `${createStateLabel(item.operation)}: ${item.reason}`,
            }))}
          />
        </DetailSection>
      ) : null}

      {plan?.checks.length ? (
        <DetailSection title="Checks">
          <RefList
            refs={plan.checks.map((check) => ({
              id: check.name,
              primary: check.name,
              secondary: `${check.required ? "Required" : "Optional"}: ${check.command}`,
            }))}
          />
        </DetailSection>
      ) : null}

      {sourceRefs.length || checkRefs.length ? (
        <DetailSection title="Run Refs">
          <RefList
            refs={[
              ...sourceRefs.map((ref) => ({ id: `source:${ref}`, primary: ref, secondary: "Source ref" })),
              ...checkRefs.map((ref) => ({ id: `check:${ref}`, primary: ref, secondary: "Check ref" })),
            ]}
          />
        </DetailSection>
      ) : null}

      <CreateContextDetails run={run} />

      {run.blockedReason ? (
        <DetailSection title="Blocked">
          <div className="goal-details-alert">
            <CircleAlert size={15} />
            <span>{run.blockedReason}</span>
          </div>
        </DetailSection>
      ) : null}

      <DetailSection title="Raw State">
        <details className="goal-details-raw">
          <summary>Show structured payload</summary>
          <pre>{JSON.stringify(run, null, 2)}</pre>
        </details>
      </DetailSection>
    </>
  );
}

function CreateContextDetails({
  run,
}: {
  run: CreateImproveRun;
}) {
  const contextItems = [
    ...run.context.attachments.map((item) => ({
      id: `attachment:${item.id ?? item.name}`,
      primary: item.name,
      secondary: item.ref ?? item.mediaType ?? "Attachment",
    })),
    ...run.context.apps.map((item) => ({
      id: `app:${item.id}`,
      primary: item.name,
      secondary: item.required ? "Required app context" : "Optional app context",
    })),
    ...run.context.tools.map((item) => ({
      id: `tool:${item.name}`,
      primary: item.name,
      secondary: item.outputSummary ?? item.inputSummary ?? "Tool context",
    })),
    ...run.context.targetRepoAssumptions.map((item) => ({
      id: `target:${item}`,
      primary: item,
      secondary: "Target assumption",
    })),
  ];
  const workflowCapture = run.workflowCapture;
  const workflowItems = workflowCapture
    ? [
        ...workflowCapture.files.map((item) => ({
          id: `workflow-file:${item}`,
          primary: item,
          secondary: "Captured file",
        })),
        ...workflowCapture.outputArtifacts.map((item) => ({
          id: `workflow-artifact:${item}`,
          primary: item,
          secondary: "Output artifact",
        })),
        ...workflowCapture.traceRefs.map((item) => ({
          id: `workflow-trace:${item}`,
          primary: item,
          secondary: "Trace",
        })),
      ]
    : [];

  if (!contextItems.length && !workflowItems.length) return null;
  return (
    <DetailSection title="Context">
      <RefList refs={[...contextItems, ...workflowItems]} />
    </DetailSection>
  );
}

function GoalRuntimeDetails({
  goalRuntime,
  subagentRuntime,
  onRunSubagentLifecycleAction,
}: {
  goalRuntime: GoalRuntimeStatus | null;
  subagentRuntime: SubagentRuntimeStatus | null;
  onRunSubagentLifecycleAction?: (input: { runId: string; action: SubagentLifecycleAction }) => Promise<void>;
}) {
  return (
    <>
      {goalRuntime ? (
        <DetailSection title="Goal">
          <p className="goal-details-summary">{goalRuntime.objective}</p>
          <DetailGrid
            rows={[
              ["Status", goalRuntime.actionLabel],
              ["Runtime", goalRuntime.timeLabel],
              ["Detail", goalRuntime.detail],
            ]}
          />
        </DetailSection>
      ) : null}
      {subagentRuntime ? (
        <SubagentDetails
          runtime={subagentRuntime}
          onRunSubagentLifecycleAction={onRunSubagentLifecycleAction}
        />
      ) : null}
      <DetailSection title="Raw State">
        <details className="goal-details-raw">
          <summary>Show structured payload</summary>
          <pre>{JSON.stringify({ goalRuntime, subagentRuntime }, null, 2)}</pre>
        </details>
      </DetailSection>
    </>
  );
}

function SubagentDetails({
  runtime,
  onRunSubagentLifecycleAction,
}: {
  runtime: SubagentRuntimeStatus;
  onRunSubagentLifecycleAction?: (input: { runId: string; action: SubagentLifecycleAction }) => Promise<void>;
}) {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  useErrorToast(actionError);
  const runLifecycleAction = async (runId: string, action: SubagentLifecycleAction) => {
    if (!onRunSubagentLifecycleAction) return;
    const key = `${runId}:${action}`;
    setPendingAction(key);
    setActionError(null);
    try {
      await onRunSubagentLifecycleAction({ runId, action });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction((current) => current === key ? null : current);
    }
  };
  return (
    <>
      <DetailSection title="Subagents">
        <DetailGrid
          rows={[
            ["Latest update", subagentLatestUpdateLabel(runtime)],
            ["Active", String(runtime.activeCount)],
            ["Completed", String(runtime.completedCount)],
            ["Failed", String(runtime.failedCount)],
            ["Cancelled", String(runtime.cancelledCount)],
            ["Paused", String(runtime.needsResumeCount)],
            ["Terminal", String(runtime.terminalCount)],
            ["Usage", subagentUsageLabel(runtime.usage.totalTokens, runtime.usage.requestCount)],
            ["Evidence", String(runtime.evidenceRefs.length)],
            ["Checks", String(runtime.testsRunCount)],
          ]}
        />
        {runtime.blockers.length > 0 ? (
          <ul className="goal-details-list compact">
            {runtime.blockers.slice(0, 4).map((blocker) => (
              <li className="goal-details-list-item" key={`${blocker.runId}:${blocker.message}`}>
                <span className={`goal-details-inline-state ${blocker.status}`}>{blocker.status}</span>
                <div>
                  <strong>{subagentRoleLabel(blocker.roleId)}</strong>
                  <p>{blocker.message}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        <ul className="goal-details-list">
          {runtime.runs.slice(0, 8).map((run) => (
            <li className="goal-details-list-item" key={run.id}>
              <span className={`goal-details-inline-state ${run.status}`}>{run.status}</span>
              <div>
                <strong>{subagentRoleLabel(run.roleId)}</strong>
                <p>{run.objective}</p>
                {run.report?.summary ? <small>{run.report.summary}</small> : null}
                {onRunSubagentLifecycleAction ? (
                  <SubagentLifecycleActions
                    pendingAction={pendingAction}
                    run={run}
                    onRun={runLifecycleAction}
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </DetailSection>
      {runtime.finalResults.length > 0 ? <SubagentFinalResultDetails results={runtime.finalResults} /> : null}
    </>
  );
}

function SubagentFinalResultDetails({ results }: { results: SubagentFinalResultSummary[] }) {
  return (
    <DetailSection title="Child Results">
      <ol className="goal-details-task-graph">
        {results.slice(0, 6).map((result) => (
          <li className="goal-details-task-node" key={result.runId}>
            <div className="goal-details-task-node-header">
              <span className={`goal-details-inline-state ${result.status}`}>{result.status}</span>
              <div>
                <strong>{subagentRoleLabel(result.roleId)}</strong>
                <small>{result.objective}</small>
              </div>
            </div>
            <p>{result.summary}</p>
            <div className="goal-details-task-node-meta">
              <span>{result.refs.length} refs</span>
              <span>{result.testsRun.length + result.validationAttempts.length} checks</span>
              <span>{result.blockers.length} blockers</span>
              <span>{result.confidence ? `${createStateLabel(result.confidence)} confidence` : "Confidence unknown"}</span>
            </div>
            {result.findings.length > 0 ? <small>Findings: {compactList(result.findings, 3)}</small> : null}
            {result.changedFiles.length > 0 ? <small>Files: {compactList(result.changedFiles, 4)}</small> : null}
            {result.testsRun.length > 0 ? <small>Tests: {compactList(result.testsRun, 3)}</small> : null}
            {result.validationAttempts.length > 0 ? (
              <small>Validation: {compactList(result.validationAttempts, 2)}</small>
            ) : null}
            {result.refs.length > 0 ? <small>Refs: {compactList(result.refs.map(subagentRefLabel), 4)}</small> : null}
            {result.blockers.length > 0 ? <small>Blockers: {compactList(result.blockers, 3)}</small> : null}
            {result.workspaceRetention ? (
              <small>Workspace: {subagentWorkspaceRetentionLabel(result.workspaceRetention)}</small>
            ) : null}
            {result.importantMessages.length > 0 ? (
              <small>Messages: {compactList(result.importantMessages.map(subagentMessageLabel), 2)}</small>
            ) : null}
          </li>
        ))}
      </ol>
    </DetailSection>
  );
}

function SubagentLifecycleActions({
  pendingAction,
  run,
  onRun,
}: {
  pendingAction: string | null;
  run: SubagentRun;
  onRun: (runId: string, action: SubagentLifecycleAction) => Promise<void>;
}) {
  const actions = subagentLifecycleActionsForRun(run);
  if (actions.length === 0) return null;
  return (
    <div className="goal-details-actions">
      {actions.map((action) => {
        const key = `${run.id}:${action}`;
        const pending = pendingAction === key;
        return (
          <button
            key={action}
            type="button"
            disabled={Boolean(pendingAction)}
            onClick={() => void onRun(run.id, action)}
          >
            {pending ? "Working..." : subagentLifecycleActionLabel(action)}
          </button>
        );
      })}
    </div>
  );
}

function subagentLifecycleActionsForRun(run: SubagentRun): SubagentLifecycleAction[] {
  const actions: SubagentLifecycleAction[] = [];
  const canCleanup = subagentRunCleanupEligible(run);
  const canArchive = subagentRunArchiveEligible(run);
  if (canCleanup) actions.push("cleanup");
  if (canArchive) actions.push("archive");
  return actions;
}

function subagentLifecycleActionLabel(action: SubagentLifecycleAction): string {
  if (action === "cleanup") return "Clean";
  if (action === "archive") return "Archive";
  return "Clean + archive";
}

function subagentRunCleanupEligible(run: SubagentRun): boolean {
  if (!subagentRunTerminalOrAccepted(run)) return false;
  const metadata = asRecord(run.metadata);
  if (!metadata?.subagentWorkspace && !metadata?.workspaceHandoff) return false;
  const cleanup = asRecord(metadata.lifecycleCleanup);
  const workspaceCleanup = asRecord(cleanup?.workspaceCleanup);
  const status = stringValue(workspaceCleanup?.status);
  return status !== "removed" && status !== "deleted" && status !== "retained" && status !== "skipped";
}

function subagentRunArchiveEligible(run: SubagentRun): boolean {
  if (!run.childSessionId || !subagentRunTerminalOrAccepted(run)) return false;
  const archive = asRecord(asRecord(run.metadata)?.childSessionArchive);
  const status = stringValue(archive?.status);
  return status !== "archived" && status !== "already_archived";
}

function subagentRunTerminalOrAccepted(run: SubagentRun): boolean {
  return run.status === "completed" ||
    run.status === "failed" ||
    run.status === "cancelled";
}

function subagentLatestUpdateLabel(runtime: SubagentRuntimeStatus): string {
  const update = runtime.latestMeaningfulUpdate;
  if (!update) return "No structured update";
  return `${subagentRoleLabel(update.roleId)} ${update.status}: ${update.message}`;
}

function subagentUsageLabel(totalTokens: number, requestCount: number): string {
  if (totalTokens <= 0 && requestCount <= 0) return "0 tokens";
  const requestLabel = `${requestCount} ${requestCount === 1 ? "request" : "requests"}`;
  return `${formatTokenCount(totalTokens)} tokens · ${requestLabel}`;
}

function subagentRoleLabel(roleId: string): string {
  return roleId.slice(0, 1).toUpperCase() + roleId.slice(1).replace(/[-_]+/g, " ");
}

function subagentRefLabel(ref: SubagentFinalResultSummary["refs"][number]): string {
  return `${ref.kind}: ${ref.label}`;
}

function subagentMessageLabel(message: SubagentFinalResultSummary["importantMessages"][number]): string {
  return `${createStateLabel(message.kind)}: ${message.body}`;
}

function subagentWorkspaceRetentionLabel(
  retention: NonNullable<SubagentFinalResultSummary["workspaceRetention"]>,
): string {
  const expiry = retention.expiresAt ? `until ${formatTimestamp(retention.expiresAt)}` : "for inspection";
  const trigger = retention.trigger ? ` · ${createStateLabel(retention.trigger)}` : "";
  return `retained ${expiry}${trigger}`;
}

function compactList(values: string[], limit: number): string {
  const visible = values.slice(0, limit);
  const hidden = values.length - visible.length;
  return hidden > 0 ? `${visible.join(", ")} +${hidden}` : visible.join(", ");
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000;
    return `${trimFixed(value, value < 10 ? 2 : 1)}M`;
  }
  const value = tokens / 1000;
  return `${trimFixed(value, value < 10 ? 1 : 0)}k`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function trimFixed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function EmptyDetails() {
  return (
    <div className="goal-details-empty">
      <FileText size={18} />
      <span>No active Goal or Create workflow.</span>
    </div>
  );
}

function DetailSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="goal-details-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function DetailGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="goal-details-grid">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RefList({
  refs,
}: {
  refs: Array<{ id: string; primary: string; secondary: string }>;
}) {
  return (
    <ul className="goal-details-ref-list">
      {refs.map((ref) => (
        <li key={ref.id}>
          <code title={ref.primary}>{ref.primary}</code>
          <span>{ref.secondary}</span>
        </li>
      ))}
    </ul>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function createStateLabel(value: string): string {
  return value
    .split(/[_-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function createStateTone(state: CreateImproveRun["state"] | null): "active" | "warning" | "success" | "danger" {
  if (state === "ready_local" || state === "published_hosted") return "success";
  if (state === "blocked" || state === "failed" || state === "cancelled") return "danger";
  if (state === "awaiting_questions" || state === "awaiting_plan_approval") return "warning";
  return "active";
}
