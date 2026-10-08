import { z } from "zod";
import type { OpenPondAppServerOptions } from "../../apps/server/src/app-server-runtime.js";
import type { ExternalChatInput } from "./config.js";
import { ExampleError } from "./config.js";
import { readResponseJson } from "./http-json.js";

const completionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        id: z.string(), type: z.literal("function"),
        function: z.object({ name: z.string(), arguments: z.string() }),
      })).optional(),
    }),
    finish_reason: z.string(),
  })).min(1),
  usage: z.record(z.string(), z.unknown()).optional(),
});

/** A complete response is fed into the existing agent loop; there is no second loop here. */
export function createModelStream(config: {
  modelEndpoint: string; model: string; maxOutputTokens?: number; systemPrompt?: string; temperature?: number;
}, credentials: Pick<ExternalChatInput["credentials"], "modelApiKey">, signal: AbortSignal):
NonNullable<OpenPondAppServerOptions["streamOpenPondHostedChatTurn"]> {
  let calls = 0;
  return async function* (request) {
    if (++calls > 4) throw new ExampleError("model_round_limit");
    const response = await fetch(`${config.modelEndpoint.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", redirect: "error",
      signal: AbortSignal.any([signal, request.signal ?? new AbortController().signal]),
      headers: { authorization: `Bearer ${credentials.modelApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        // The small no-tool deployment uses its fixed harness instruction instead
        // of advertising the desktop-wide authoring, skill and coordination catalog.
        messages: config.systemPrompt === undefined ? request.messages : [
          { role: "system", content: config.systemPrompt },
          ...request.messages.filter(message => message.role !== "system"),
        ],
        temperature: config.temperature, tools: request.tools,
        tool_choice: request.toolChoice, max_tokens: Math.min(request.maxTokens ?? 2048, config.maxOutputTokens ?? 2048), stream: false,
      }),
    });
    const completion = completionSchema.parse(await readResponseJson(response));
    const choice = completion.choices[0]!;
    if (completion.usage) yield { type: "usage", usage: completion.usage, raw: null };
    if (choice.message.content) yield { type: "text_delta", text: choice.message.content, raw: null };
    if (choice.message.tool_calls?.length) yield { type: "tool_call_delta", toolCalls: choice.message.tool_calls, raw: null };
    yield { type: "finish", finishReason: choice.finish_reason, raw: null };
  };
}
