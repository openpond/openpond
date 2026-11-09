import { SessionUserQuestionSchema } from "@openpond/contracts/user-questions";
import { createAuthoringModelToolDefinitions } from "../../openpond/authoring-tool-registry.js";
import type { ModelToolDefinition } from "../../openpond/model-tool-registry.js";
import type { createNativeAgentApprovals } from "./approvals.js";

type RequestQuestion = ReturnType<typeof createNativeAgentApprovals>["request"];
const Question = SessionUserQuestionSchema.pick({ question: true, reason: true, options: true });

export const NATIVE_QUESTION_INSTRUCTIONS = "Use ask_user for a necessary user choice or a concrete total-spend approval. It shows the app's question form and waits for the user's answer within this turn, then lets you continue. Ask only for information not already supplied. A skipped question is not approval; never start paid work while waiting or interpret an unrelated answer as approval.";

/** Reuse the ordinary question contract and the existing pending-approval owner.
 * This works in a normal native chat without switching Codex into Plan mode. */
export function createNativeQuestionTool(request: RequestQuestion): ModelToolDefinition {
  const base = createAuthoringModelToolDefinitions({}).find(tool => tool.name === "ask_user")!;
  const properties = { ...base.parameters.properties as Record<string, unknown> };
  // Native questions always offer a freeform answer alongside suggested choices.
  delete properties.allowFreeform;
  return {
    ...base,
    description: "Ask one necessary question through the app's user-input form. Suggested choices and a freeform answer are supported. This tool waits for the answer and resumes the same turn; do not batch it with mutations. Skipping is not approval.",
    parameters: { ...base.parameters, properties },
    execute: async context => {
      const prepared = await base.execute(context);
      const question = Question.parse(prepared.data);
      const result = await request(context.session.id, context.turnId, {
        sessionId: context.session.id,
        toolCall: { toolCallId: context.callId, title: question.question, toolName: "ask_user" },
        questions: [{ question: question.question,
          ...(question.reason ? { header: question.reason.slice(0, 200) } : {}),
          options: question.options.map(option => ({ label: option.label,
            ...(option.description ? { description: option.description } : {}) })) }],
        options: [{ optionId: "answer", name: "Answer", kind: "allow_once" },
          { optionId: "dismiss", name: "Skip", kind: "reject_once" }],
      }, context.signal);
      const answered = result.outcome.outcome === "selected" && result.outcome.optionId === "answer";
      const data = { question: question.question, status: answered ? "answered" : "dismissed",
        answer: answered ? result.answers?.[question.question] ?? null : null };
      return { toolCallId: context.callId, name: "ask_user", ok: true, data,
        contentText: JSON.stringify(data) };
    },
  };
}
