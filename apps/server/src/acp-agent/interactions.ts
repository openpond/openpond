import { methods, type AgentContext } from "@agentclientprotocol/sdk";
import type { SessionUserQuestion, SessionUserQuestionResolution } from "@openpond/contracts/user-questions";
import { record } from "./events.js";

/** SDK cancellation is cooperative; race locally so a silent client cannot keep tools alive. */
export async function boundedInteraction<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]);
  bounded.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(bounded.reason);
    bounded.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([operation(bounded), cancelled]); }
  finally { bounded.removeEventListener("abort", abort); }
}

export async function permission(client: AgentContext, signal: AbortSignal, sessionId: string, toolCallId: string, title: string, kind: "execute" | "other" | "edit" | "delete", rawInput?: unknown): Promise<boolean> {
  try {
    const result = await boundedInteraction(signal, cancellationSignal => client.request(methods.client.session.requestPermission, {
      sessionId, toolCall: { toolCallId, title, kind, status: "pending", rawInput },
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Reject", kind: "reject_once" }],
    }, { cancellationSignal }));
    return !signal.aborted && result.outcome.outcome === "selected" && result.outcome.optionId === "allow";
  } catch { return false; }
}

export async function askQuestion(client: AgentContext, signal: AbortSignal, question: SessionUserQuestion): Promise<SessionUserQuestionResolution | null> {
  try {
    const response = await boundedInteraction(signal, cancellationSignal => client.request(methods.client.elicitation.create, {
      mode: "form", sessionId: question.sessionId, toolCallId: question.toolCallId, message: question.question,
      requestedSchema: { type: "object", properties: {
        ...(question.options.length ? { option: { type: "string", title: "Choice", enum: question.options.map(option => option.id), enumNames: question.options.map(option => option.label) } } : {}),
        ...(question.allowFreeform ? { answer: { type: "string", title: "Answer", maxLength: 4000 } } : {}),
      }, required: question.allowFreeform ? [] : ["option"] },
    }, { cancellationSignal }));
    if (signal.aborted) return null;
    if (response.action !== "accept") return { questionId: question.id, action: "dismiss", text: "", optionId: null };
    const values = record(response.content);
    const optionId = typeof values.option === "string" && question.options.some(option => option.id === values.option) ? values.option : null;
    const text = question.allowFreeform && typeof values.answer === "string" ? values.answer.trim().slice(0, 4000) : "";
    if (!optionId && !text) return { questionId: question.id, action: "dismiss", text: "", optionId: null };
    return { questionId: question.id, action: "answer", optionId, text };
  } catch { return null; }
}
