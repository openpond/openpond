import { sha256 } from "@openpond/harness";
import { FileOutputRefSchema, type RuntimeEvent } from "@openpond/contracts";
import { z } from "zod";

const CompletionSchema = z.object({
  schemaVersion: z.literal("openpond.profileWorkCompletion.v1"),
  sessionId: z.string().min(1), turnId: z.string().min(1),
  responsePath: z.string().min(1), responseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  responseBytes: z.number().int().min(1).max(1_048_576),
  // Chunks stay below the runtime-event sanitizer's individual string limit.
  responseChunks: z.array(z.string().max(65_536)).min(1).max(32),
  outputs: z.array(z.object({id:z.string(),revision:z.number().int(),sha256:z.string(),sizeBytes:z.number().int(),contentType:z.string(),sourceTaskId:z.string(),sourceTurnId:z.string(),title:z.string()}).strict()).min(1).max(100),
}).strict();

export function createProfileWorkCompletion(input: {
  sessionId: string; turnId: string; responsePath: string;
  response: Buffer; outputs: z.infer<typeof FileOutputRefSchema>[];
}) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(input.response);
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += 65_536) chunks.push(text.slice(offset, offset + 65_536));
  return CompletionSchema.parse({ schemaVersion: "openpond.profileWorkCompletion.v1",
    sessionId: input.sessionId, turnId: input.turnId, responsePath: input.responsePath,
    responseSha256: sha256(input.response), responseBytes: input.response.length,
    responseChunks: chunks, outputs: input.outputs.map(({id,revision,sha256,sizeBytes,contentType,sourceTaskId,sourceTurnId,title})=>({id,revision,sha256,sizeBytes,contentType,sourceTaskId,sourceTurnId,title})) });
}

/** Recover full policy-authored content from the exact successful tool result.
 * A response marker cannot replace missing, unrelated or changed saved bytes. */
export function completedProfileWorkResponse(events: RuntimeEvent[]): string | null {
  const completions = events.filter(event => event.name === "tool.completed"
    && event.action === "work_finish" && event.status === "completed");
  if (!completions.length) return null;
  if (completions.length !== 1) throw new Error("The case has multiple Work completion receipts.");
  const event = completions[0]!;
  const data = event.data as { result?: unknown } | undefined;
  const completion = CompletionSchema.parse(data?.result);
  if (completion.sessionId !== event.sessionId || completion.turnId !== event.turnId)
    throw new Error("Work completion belongs to another case or turn.");
  const text = completion.responseChunks.join(""), bytes = Buffer.from(text, "utf8");
  if (bytes.length !== completion.responseBytes || sha256(bytes) !== completion.responseSha256)
    throw new Error("Work completion response differs from its sealed content.");
  if(new Set(completion.outputs.map(output=>`${output.id}/${output.revision}`)).size!==completion.outputs.length)throw new Error("Work completion repeats a saved output.");
  const preceding = events.slice(0, events.indexOf(event));
  for (const output of completion.outputs) {
    if (output.sourceTaskId !== completion.sessionId || output.sourceTurnId !== completion.turnId)
      throw new Error("Work completion output belongs to another case or turn.");
    const matches = preceding.filter(saved => saved.name === "workspace_action_result"
      && saved.action === "work_output_save" && saved.status === "completed"
      && saved.sessionId === completion.sessionId && saved.turnId === completion.turnId)
      .flatMap(saved => {
        const parsed = FileOutputRefSchema.safeParse((saved.data as { outputRef?: unknown } | undefined)?.outputRef);
        return parsed.success && Object.entries(output).every(([key,value])=>(parsed.data as Record<string,unknown>)[key]===value) ? [parsed.data] : [];
      });
    if (matches.length !== 1) throw new Error("Work completion lacks an exact prior saved-output receipt.");
  }
  return text;
}
