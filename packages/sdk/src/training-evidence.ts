import { z } from "zod";
import { OpenPondProtocolError, TRAINING_API_RESPONSE_MAX_BYTES, canonicalJsonByteLength } from "./protocol.js";
import { TrainingJobEventSchema, TrainingJobLogSchema } from "./training-job-contracts.js";

export const TrainingEvidenceWindowSchema = z.object({
  after: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();
export type TrainingEvidenceWindow = z.input<typeof TrainingEvidenceWindowSchema>;

export function createTrainingEvidenceClient(request: (path: string) => Promise<unknown>) {
  async function read<S extends typeof TrainingJobEventSchema | typeof TrainingJobLogSchema>(
    jobId: string, kind: "events" | "logs", schema: S, input: TrainingEvidenceWindow = {},
  ) {
    const id = z.string().trim().min(1).max(500).parse(jobId);
    const window = TrainingEvidenceWindowSchema.parse(input);
    const raw = await request(`/v1/training/jobs/${encodeURIComponent(id)}/${kind}?${new URLSearchParams({
      after: String(window.after), limit: String(window.limit),
    })}`);
    const page = z.object({ [kind]: z.array(schema).max(window.limit),
      nextOffset: z.number().int().min(0).max(1_000_100).nullable() }).strict().parse(raw);
    const items = page[kind] as z.output<S>[];
    if (items.some((item, index) => item.jobId !== id || item.sequence !== window.after + index)
      || (page.nextOffset !== null && (items.length !== window.limit || page.nextOffset !== window.after + items.length)))
      throw new OpenPondProtocolError("response_scope_mismatch", "Training evidence does not match the requested job or window.");
    return { items, nextOffset: page.nextOffset };
  }
  // Existing SDK consumers need complete retained evidence. Follow bounded
  // pages with an aggregate byte/record budget; MCP uses a single page only.
  async function all<S extends typeof TrainingJobEventSchema | typeof TrainingJobLogSchema>(jobId: string, kind: "events" | "logs", schema: S) {
    const items: z.output<S>[] = [];
    let after = 0;
    let bytes = 0;
    for (;;) {
      const page = await read(jobId, kind, schema, { after, limit: 100 });
      bytes += canonicalJsonByteLength(page.items);
      if (bytes > TRAINING_API_RESPONSE_MAX_BYTES || items.length + page.items.length > 100_000)
        throw new OpenPondProtocolError("response_too_large", "Training evidence exceeds the aggregate read budget; use paged reads.");
      items.push(...page.items);
      if (page.nextOffset === null) return items;
      after = page.nextOffset;
    }
  }
  return {
    events: (jobId: string) => all(jobId, "events", TrainingJobEventSchema),
    logs: (jobId: string) => all(jobId, "logs", TrainingJobLogSchema),
    /** Bounded current snapshot. Lifecycle rows can change while a run is live. */
    eventsPage: (jobId: string, window?: TrainingEvidenceWindow) => read(jobId, "events", TrainingJobEventSchema, window),
    logsPage: (jobId: string, window?: TrainingEvidenceWindow) => read(jobId, "logs", TrainingJobLogSchema, window),
  };
}
