import { SessionUserQuestionSchema } from "@openpond/contracts/user-questions";
import type { RuntimeEvent } from "@openpond/contracts/runtime";
import type { Session } from "@openpond/contracts/sessions";
import type { NativeModelToolResult } from "../../openpond/native-tool-calls.js";
import { event } from "../../utils.js";

/** Both hosted and native tools publish the same durable question. Its answer
 * uses the ordinary validated chat continuation, rather than a live RPC waiter. */
export async function persistUserQuestion(
  result: NativeModelToolResult,
  session: Pick<Session, "id" | "appId">,
  turnId: string,
  append: (event: RuntimeEvent) => Promise<void>,
) {
  if (result.name !== "ask_user" || !result.ok) return;
  const data = result.data && typeof result.data === "object" && !Array.isArray(result.data)
    ? result.data as Record<string, unknown> : {};
  const question = SessionUserQuestionSchema.parse({
    id: data.questionId, sessionId: session.id, turnId, toolCallId: result.toolCallId,
    question: data.question, reason: data.reason ?? null, options: data.options ?? [],
    allowFreeform: data.allowFreeform !== false, status: "pending", answer: null,
    createdAt: new Date().toISOString(), answeredAt: null,
  });
  await append(event({
    sessionId: session.id, turnId, name: "user_question.asked", source: "provider",
    action: "ask_user", appId: session.appId, status: "pending",
    output: question.question, data: { question },
  }));
}
