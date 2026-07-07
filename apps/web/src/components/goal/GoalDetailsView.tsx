import type { ReactNode } from "react";
import {
  createPipelineActionShapeFromMetadata,
  type CreatePipelineRequest,
  type CreatePipelineSnapshot,
} from "@openpond/contracts";
import type { GoalRuntimeStatus } from "../../lib/goal-runtime";
import type { SubagentRuntimeStatus } from "../../lib/subagent-runtime";
import { CircleAlert, FileText } from "../icons";

export type GoalDetailsCreateRuntime = {
  turnId: string | null;
  request: CreatePipelineRequest;
  snapshot: CreatePipelineSnapshot | null;
};

export type GoalDetailsViewProps = {
  createRuntime: GoalDetailsCreateRuntime | null;
  goalRuntime: GoalRuntimeStatus | null;
  subagentRuntime?: SubagentRuntimeStatus | null;
};

export function GoalDetailsView({ createRuntime, goalRuntime, subagentRuntime = null }: GoalDetailsViewProps) {
  const title = createRuntime ? "Create Plan Details" : "Goal Details";
  const stateLabel = createRuntime
    ? createStateLabel(createRuntime.snapshot?.state ?? "planning")
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
        <span className={`goal-details-state ${createStateTone(createRuntime?.snapshot?.state ?? null)}`}>
          {stateLabel}
        </span>
      </div>
      <div className="goal-details-body">
        {createRuntime ? (
          <CreateDetails runtime={createRuntime} />
        ) : goalRuntime || subagentRuntime ? (
          <GoalRuntimeDetails goalRuntime={goalRuntime} subagentRuntime={subagentRuntime} />
        ) : (
          <EmptyDetails />
        )}
      </div>
    </div>
  );
}

function CreateDetails({ runtime }: { runtime: GoalDetailsCreateRuntime }) {
  const { request, snapshot } = runtime;
  const plan = snapshot?.plan ?? null;
  const actionShape =
    createPipelineActionShapeFromMetadata(plan?.metadata) ??
    createPipelineActionShapeFromMetadata(request.metadata);
  const questions = snapshot?.questions ?? [];
  const pendingQuestions = questions.filter((question) => question.status === "pending");
  const sourceRefs = snapshot?.sourceRefs ?? [];
  const checkRefs = snapshot?.checkRefs ?? [];
  const state = snapshot?.state ?? "planning";

  return (
    <>
      <DetailSection title="Create State">
        <DetailGrid
          rows={[
            ["State", createStateLabel(state)],
            ["Operation", request.operation],
            ["Surface", createStateLabel(request.surface)],
            ["Command", request.command],
            ["Agent", request.targetAgent.displayName ?? request.targetAgent.agentId ?? "Model will decide"],
            ["Agent ID", request.targetAgent.agentId ?? "Pending"],
            ["Default action", request.targetAgent.defaultActionKey ?? plan?.defaultChatAction.key ?? "Pending"],
            ["Adapter", createStateLabel(request.adapter.kind)],
            ["Turn", runtime.turnId ?? "Pending"],
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
                ["Goal ID", plan.goalId],
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

      <CreateContextDetails request={request} snapshot={snapshot} />

      {snapshot?.blockedReason ? (
        <DetailSection title="Blocked">
          <div className="goal-details-alert">
            <CircleAlert size={15} />
            <span>{snapshot.blockedReason}</span>
          </div>
        </DetailSection>
      ) : null}

      <DetailSection title="Raw State">
        <details className="goal-details-raw">
          <summary>Show structured payload</summary>
          <pre>{JSON.stringify({ request, snapshot }, null, 2)}</pre>
        </details>
      </DetailSection>
    </>
  );
}

function CreateContextDetails({
  request,
  snapshot,
}: {
  request: CreatePipelineRequest;
  snapshot: CreatePipelineSnapshot | null;
}) {
  const contextItems = [
    ...request.context.attachments.map((item) => ({
      id: `attachment:${item.id ?? item.name}`,
      primary: item.name,
      secondary: item.ref ?? item.mediaType ?? "Attachment",
    })),
    ...request.context.apps.map((item) => ({
      id: `app:${item.id}`,
      primary: item.name,
      secondary: item.required ? "Required app context" : "Optional app context",
    })),
    ...request.context.tools.map((item) => ({
      id: `tool:${item.name}`,
      primary: item.name,
      secondary: item.outputSummary ?? item.inputSummary ?? "Tool context",
    })),
    ...request.context.targetRepoAssumptions.map((item) => ({
      id: `target:${item}`,
      primary: item,
      secondary: "Target assumption",
    })),
  ];
  const workflowCapture = snapshot?.workflowCapture;
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
}: {
  goalRuntime: GoalRuntimeStatus | null;
  subagentRuntime: SubagentRuntimeStatus | null;
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
      {subagentRuntime ? <SubagentDetails runtime={subagentRuntime} /> : null}
      <DetailSection title="Raw State">
        <details className="goal-details-raw">
          <summary>Show structured payload</summary>
          <pre>{JSON.stringify({ goalRuntime, subagentRuntime }, null, 2)}</pre>
        </details>
      </DetailSection>
    </>
  );
}

function SubagentDetails({ runtime }: { runtime: SubagentRuntimeStatus }) {
  return (
    <>
      <DetailSection title="Subagents">
        <DetailGrid
          rows={[
            ["Active", String(runtime.activeCount)],
            ["Blocked", String(runtime.blockedCount)],
            ["Completed", String(runtime.completedCount)],
            ["Required open", String(runtime.requiredOpenCount)],
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
              </div>
            </li>
          ))}
        </ul>
      </DetailSection>
      {runtime.taskGraph.nodes.length > 0 ? <SubagentTaskGraphDetails runtime={runtime} /> : null}
    </>
  );
}

function SubagentTaskGraphDetails({ runtime }: { runtime: SubagentRuntimeStatus }) {
  const edgesByTarget = new Map<string, typeof runtime.taskGraph.edges>();
  for (const edge of runtime.taskGraph.edges) {
    const bucket = edgesByTarget.get(edge.toRunId) ?? [];
    bucket.push(edge);
    edgesByTarget.set(edge.toRunId, bucket);
  }
  return (
    <DetailSection title="Task Graph">
      <ol className="goal-details-task-graph">
        {runtime.taskGraph.nodes.map((node) => {
          const incoming = edgesByTarget.get(node.runId) ?? [];
          return (
            <li className="goal-details-task-node" key={node.runId}>
              <div className="goal-details-task-node-header">
                <span className={`goal-details-inline-state ${node.status}`}>{node.status}</span>
                <div>
                  <strong>{subagentRoleLabel(node.roleId)}</strong>
                  <small>{node.modelLabel} · {node.isolationLabel}</small>
                </div>
              </div>
              <p>{node.objective}</p>
              <div className="goal-details-task-node-meta">
                <span>{node.required ? "Required" : "Optional"}</span>
                <span>{node.evidenceCount} evidence</span>
                <span>{node.testsRunCount} checks</span>
                <span>{node.blockerCount} blockers</span>
              </div>
              {incoming.length > 0 ? (
                <div className="goal-details-task-edges">
                  {incoming.slice(0, 3).map((edge) => (
                    <span key={edge.id}>{edgeLabel(edge.fromRunId, edge.label, runtime.sessionId)}</span>
                  ))}
                </div>
              ) : null}
              {node.summary ? <small>{node.summary}</small> : null}
            </li>
          );
        })}
      </ol>
    </DetailSection>
  );
}

function edgeLabel(fromRunId: string, label: string, sessionId: string): string {
  if (fromRunId === `parent:${sessionId}`) return `Parent ${label.toLowerCase()}`;
  if (fromRunId.startsWith("parent:")) return `Parent ${label.toLowerCase()}`;
  return `${fromRunId} ${label.toLowerCase()}`;
}

function subagentUsageLabel(totalTokens: number, requestCount: number): string {
  if (totalTokens <= 0 && requestCount <= 0) return "0 tokens";
  const requestLabel = `${requestCount} ${requestCount === 1 ? "request" : "requests"}`;
  return `${formatTokenCount(totalTokens)} tokens · ${requestLabel}`;
}

function subagentRoleLabel(roleId: string): string {
  return roleId.slice(0, 1).toUpperCase() + roleId.slice(1).replace(/[-_]+/g, " ");
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

function createStateLabel(value: string): string {
  return value
    .split(/[_-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function createStateTone(state: CreatePipelineSnapshot["state"] | null): "active" | "warning" | "success" | "danger" {
  if (state === "ready_local" || state === "published_hosted") return "success";
  if (state === "blocked" || state === "failed" || state === "cancelled") return "danger";
  if (state === "awaiting_questions" || state === "awaiting_plan_approval") return "warning";
  return "active";
}
