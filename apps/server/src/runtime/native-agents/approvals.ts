import { randomUUID } from "node:crypto";
import { ResolveApprovalRequestSchema } from "@openpond/contracts/requests";
import { type Approval } from "@openpond/contracts/approvals";
import { type RuntimeEvent } from "@openpond/contracts/runtime";
import type { AcpPermissionRequest, AcpPermissionResult } from "@openpond/agent-runtime";
import { event, now } from "../../utils.js";
import { z } from "zod";

const Questions = z.array(z.object({ question: z.string().min(1).max(2000), header: z.string().max(200).optional(), multiSelect: z.boolean().optional(), options: z.array(z.object({ label: z.string().min(1).max(1000), description: z.string().max(4000).optional() })).max(30) })).min(1).max(10);

export function createNativeAgentApprovals(deps: {
  upsertApproval(approval: Approval): Promise<void>;
  appendRuntimeEvent(event: RuntimeEvent): Promise<void>;
}) {
  const pending = new Map<string, { approval: Approval; request: AcpPermissionRequest; ready: Promise<void>; settle(result: AcpPermissionResult): void }>();
  async function finish(id: string, status: Approval["status"], result: AcpPermissionResult): Promise<Approval | null> {
    const entry = pending.get(id);
    if (!entry) return null;
    pending.delete(id);
    const approval = { ...entry.approval, status };
    try {
      await entry.ready;
      await deps.upsertApproval(approval);
      await deps.appendRuntimeEvent(event({ sessionId: approval.sessionId, turnId: approval.turnId ?? undefined, name: "approval.resolved", source: "server", data: { approvalId: id, status } }));
      entry.settle(result);
    } catch (error) { entry.settle({ outcome: { outcome: "cancelled" } }); throw error; }
    return approval;
  }
  return {
    async request(sessionId: string, turnId: string, request: AcpPermissionRequest, signal: AbortSignal): Promise<AcpPermissionResult> {
      if (signal.aborted) return { outcome: { outcome: "cancelled" } };
      const questions = request.questions ? Questions.parse(request.questions) : undefined;
      if (questions && new Set(questions.map((question) => question.question)).size !== questions.length) throw new Error("Native agent returned duplicate question identities.");
      const approval: Approval = { id: randomUUID(), sessionId, turnId, providerRequestId: `native-agent:${String(request.toolCall.toolCallId ?? randomUUID())}`, kind: questions ? "user_input" : "permissions", title: String(request.toolCall.title ?? "Agent permission"), detail: JSON.stringify({ toolCall: request.toolCall, options: request.options, questions }), status: "pending", createdAt: now() };
      let settle!: (result: AcpPermissionResult) => void;
      const result = new Promise<AcpPermissionResult>((resolve) => { settle = resolve; });
      const ready = (async () => {
        await deps.upsertApproval(approval);
        if (!signal.aborted) await deps.appendRuntimeEvent(event({ sessionId, turnId, name: "approval.requested", source: "provider", action: "permissions", status: "pending", output: approval.title, data: approval }));
      })();
      pending.set(approval.id, { approval, request, ready, settle });
      const abort = () => { void finish(approval.id, "cancelled", { outcome: { outcome: "cancelled" } }).catch(() => undefined); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        await ready;
        return await result;
      } catch (error) {
        await finish(approval.id, "cancelled", { outcome: { outcome: "cancelled" } });
        throw error;
      } finally { signal.removeEventListener("abort", abort); }
    },
    async resolve(approvalId: string, payload: unknown): Promise<Approval | null> {
      const entry = pending.get(approvalId);
      if (!entry) return null;
      const { decision, answers } = ResolveApprovalRequestSchema.parse(payload);
      if (decision === "accept" && entry.request.questions) {
        const expected = entry.request.questions.map((question) => question.question);
        if (!answers || expected.some((key) => !answers[key]) || Object.keys(answers).some((key) => !expected.includes(key))) throw new Error("Answer each requested native question before continuing.");
      } else if (answers) throw new Error("This permission request does not accept question answers.");
      const kind = decision === "accept" ? "allow_once" : decision === "acceptForSession" ? "allow_always" : "reject_once";
      const option = entry.request.options.find((candidate) => candidate.kind === kind);
      if (decision !== "cancel" && !option) throw new Error("The native agent does not offer this permission choice.");
      const status = decision === "accept" ? "accepted" : decision === "acceptForSession" ? "accepted_for_session" : decision === "cancel" ? "cancelled" : "declined";
      return finish(approvalId, status, option && decision !== "cancel" ? { outcome: { outcome: "selected", optionId: option.optionId }, ...(answers ? { answers } : {}) } : { outcome: { outcome: "cancelled" } });
    },
  };
}
