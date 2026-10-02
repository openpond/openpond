import { randomUUID } from "node:crypto";
import { ResolveApprovalRequestSchema, type Approval, type RuntimeEvent } from "@openpond/contracts";
import type { AcpPermissionRequest, AcpPermissionResult } from "@openpond/agent-runtime";
import { event, now } from "../../utils.js";

export function createNativeAgentApprovals(deps: {
  upsertApproval(approval: Approval): Promise<void>;
  appendRuntimeEvent(event: RuntimeEvent): Promise<void>;
}) {
  const pending = new Map<string, { approval: Approval; request: AcpPermissionRequest; settle(result: AcpPermissionResult): void }>();
  async function finish(id: string, status: Approval["status"], result: AcpPermissionResult): Promise<Approval | null> {
    const entry = pending.get(id);
    if (!entry) return null;
    pending.delete(id);
    const approval = { ...entry.approval, status };
    try {
      await deps.upsertApproval(approval);
      await deps.appendRuntimeEvent(event({ sessionId: approval.sessionId, turnId: approval.turnId ?? undefined, name: "approval.resolved", source: "server", data: { approvalId: id, status } }));
      entry.settle(result);
    } catch (error) { entry.settle({ outcome: { outcome: "cancelled" } }); throw error; }
    return approval;
  }
  return {
    async request(sessionId: string, turnId: string, request: AcpPermissionRequest, signal: AbortSignal): Promise<AcpPermissionResult> {
      if (signal.aborted) return { outcome: { outcome: "cancelled" } };
      const approval: Approval = { id: randomUUID(), sessionId, turnId, providerRequestId: `native-agent:${String(request.toolCall.toolCallId ?? randomUUID())}`, kind: "permissions", title: String(request.toolCall.title ?? "Agent permission"), detail: JSON.stringify({ toolCall: request.toolCall, options: request.options }), status: "pending", createdAt: now() };
      let settle!: (result: AcpPermissionResult) => void;
      const result = new Promise<AcpPermissionResult>((resolve) => { settle = resolve; });
      const abort = () => { void finish(approval.id, "cancelled", { outcome: { outcome: "cancelled" } }).catch(() => undefined); };
      try {
        await deps.upsertApproval(approval);
        pending.set(approval.id, { approval, request, settle });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else await deps.appendRuntimeEvent(event({ sessionId, turnId, name: "approval.requested", source: "provider", action: "permissions", status: "pending", output: approval.title, data: approval }));
        return await result;
      } catch (error) {
        await finish(approval.id, "cancelled", { outcome: { outcome: "cancelled" } });
        throw error;
      } finally { signal.removeEventListener("abort", abort); }
    },
    async resolve(approvalId: string, payload: unknown): Promise<Approval | null> {
      const entry = pending.get(approvalId);
      if (!entry) return null;
      const { decision } = ResolveApprovalRequestSchema.parse(payload);
      const kind = decision === "accept" ? "allow_once" : decision === "acceptForSession" ? "allow_always" : "reject_once";
      const option = entry.request.options.find((candidate) => candidate.kind === kind);
      if (decision !== "cancel" && !option) throw new Error("The native agent does not offer this permission choice.");
      const status = decision === "accept" ? "accepted" : decision === "acceptForSession" ? "accepted_for_session" : decision === "cancel" ? "cancelled" : "declined";
      return finish(approvalId, status, option && decision !== "cancel" ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } });
    },
  };
}
