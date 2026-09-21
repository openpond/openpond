import { taskInputModelText, type TaskInput } from "@openpond/contracts";
import type { HostedMessages } from "../turns/ports.js";

const ASSIGNMENT_PREFIX = "OpenPond active assignment revisions (oldest first; newer user corrections supersede conflicts):\n";

/** Reproject exact user corrections after compaction; summaries cannot resurrect older constraints. */
export function projectTaskAssignment(messages: HostedMessages, inputs: TaskInput[], originalPrompt?: string): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && typeof message.content === "string" && message.content.startsWith(ASSIGNMENT_PREFIX)) messages.splice(index, 1);
  }
  if (inputs.length) messages.push({ role: "user", content: ASSIGNMENT_PREFIX + (originalPrompt ? `Original assignment:\n${originalPrompt}\n\n` : "") + inputs.map(taskInputModelText).join("\n\n") });
}

export function appendTaskInputContext(messages: HostedMessages, inputs: TaskInput[]): void {
  for (const input of inputs) {
    if (input.kind === "steer") continue;
    const content = taskInputModelText(input);
    if (!messages.some((message) => message.role === "user" && message.content === content)) messages.push({ role: "user", content });
  }
}
