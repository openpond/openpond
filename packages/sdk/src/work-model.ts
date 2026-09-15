import { z } from "zod";
import { sendHostedChatTurn, type HostedChatRequestOptions } from "@openpond/cloud/hosted-chat";

const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({
    content: z.string().nullable().optional(),
    tool_calls: z.array(z.object({
      id: z.string().min(1), type: z.literal("function"),
      function: z.object({ name: z.string().min(1), arguments: z.string() }),
    })).optional(),
  }) })).min(1),
});

export async function workModelTurn(options: HostedChatRequestOptions, custom: boolean) {
  if (!custom) return sendHostedChatTurn(options);
  const response = await fetch(`${options.apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: options.model, messages: options.messages, tools: options.tools, tool_choice: "auto", stream: false }),
    signal: options.signal,
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Configured model request failed (${response.status})`);
  return completionSchema.parse(await response.json());
}
