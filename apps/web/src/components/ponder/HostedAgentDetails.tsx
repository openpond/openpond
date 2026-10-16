import { useMemo } from "react";
import { AgentConversation } from "./AgentConversation";
import { hostedAgentMessages } from "./hosted-agent-messages";
import { HostedAgentOutput } from "./HostedAgentOutput";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PonderHostedAssignment, PonderHostedAssignmentDetail } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import { useErrorToast } from "../../app/AppToastContext";

export const hostedStateLabels: Record<PonderHostedAssignment["state"], string> = {
  preparing: "Preparing", submitting: "Submitting", running: "Working", completed: "Completed",
  needs_attention: "Needs attention", failed: "Failed", cancelled: "Cancelled", unknown: "Status unknown",
};

export function hostedLocation(assignment: PonderHostedAssignment): string {
  try { return `Hosted sandbox · ${new URL(assignment.account.apiBaseUrl).host}`; }
  catch { return "Hosted sandbox"; }
}

function retainedWaitOption(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const field of ["label", "title", "text", "name", "value"]) if (typeof record[field] === "string") return record[field];
  }
  return JSON.stringify(value) ?? String(value);
}

/** Hosted results stay remote records; no synthetic desktop session or ownership transfer. */
export function HostedAgentDetails({connection, accountScopeKey, assignment}: {connection: ClientConnection; accountScopeKey: string; assignment: PonderHostedAssignment}) {
  const queries = useQueryClient();
  const scope = connectionQueryScope(connection);
  const queryKey = ["ponder-hosted-agent", scope, accountScopeKey, assignment.id] as const;
  const path = `/v1/ponder/local/hosted-agents/${encodeURIComponent(assignment.id)}`;
  const detail = useQuery<PonderHostedAssignmentDetail>({ queryKey, staleTime: 2000, gcTime: 10 * 60 * 1000,
    refetchInterval: query => ["completed", "failed", "cancelled"].includes(query.state.data?.assignment.state ?? "") ? 30000 : 3000,
    queryFn: ({signal}) => apiFetch<PonderHostedAssignmentDetail>(connection, path, { signal }),
  });
  const cancel = useMutation({
    mutationFn: () => apiFetch<PonderHostedAssignmentDetail>(connection, `${path}/cancel`, { method: "POST", body: "{}" }),
    onSuccess: value => {
      queries.setQueryData(queryKey, value);
      void queries.invalidateQueries({ queryKey: ["ponder-hosted-agents", scope] });
    },
    onError: () => { void detail.refetch(); },
  });
  useErrorToast(detail.error);
  useErrorToast(cancel.error);
  const current = detail.data?.assignment ?? assignment;
  const messages = useMemo(() => hostedAgentMessages(current, detail.data?.events ?? []), [current, detail.data?.events]);
  const running = ["preparing", "submitting", "running"].includes(current.state);
  return <>
    <div className="ponder-agent-assignment">
      <span>{hostedLocation(current)} · {hostedStateLabels[current.state]}</span>
      {current.wait ? <div className="ponder-hosted-wait"><strong>{current.wait.title}</strong><span>This hosted assignment is waiting in its Work environment.</span>
        {current.wait.options.length ? <dl><dt>Recorded response options</dt>{current.wait.options.map((option, index) => <dd key={index}>{retainedWaitOption(option)}</dd>)}</dl> : null}
      </div> : null}
      {current.canCancel ? <button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Cancel assignment</button> : null}
    </div>
    <AgentConversation connection={connection} usageSessionId={null} conversationId={`hosted:${current.id}`} messages={messages} loading={detail.isPending} running={running}>
      {!detail.data && !detail.isPending ? <button type="button" onClick={() => void detail.refetch()}>Retry loading conversation</button> : null}
      {detail.data?.outputs.length ? <section className="ponder-hosted-outputs" aria-label="Assignment outputs"><h3>Outputs</h3>{detail.data.outputs.map(output => <HostedAgentOutput key={`${accountScopeKey}:${current.id}:${output.id}`} connection={connection} accountScopeKey={accountScopeKey} assignmentId={current.id} output={output}/>)}</section> : null}
    </AgentConversation>
  </>;
}
