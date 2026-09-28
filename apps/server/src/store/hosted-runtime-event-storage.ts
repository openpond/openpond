import { randomUUID } from "node:crypto";
import { RuntimeEventSchema, type RuntimeEvent } from "@openpond/contracts";
import {
  HOST_STORAGE_CONTRACT_VERSION,
  type AgentHostStorageClient,
} from "@openpond/agent-runtime";
import { z } from "zod";

const pageSchema = z.object({
  entries: z.array(z.object({ sequence: z.number().int().positive(), event: RuntimeEventSchema })).max(200),
  totalMatchingEvents: z.number().int().nonnegative(),
  remainingMatchingEvents: z.number().int().nonnegative(),
}).strict();

/** The event ID is also the retry identity; the host owns the sequence. */
export class HostedRuntimeEventStorage {
  constructor(private readonly client: AgentHostStorageClient) {}

  async runtimeEventsForSession(sessionId: string, query: {
    afterSequence?: number | null; names?: readonly RuntimeEvent["name"][]; limit?: number | null;
  } = {}): Promise<RuntimeEvent[]> {
    const requested = query.limit == null ? 10_000 : Math.max(0, Math.trunc(query.limit));
    if (requested === 0) return [];
    const maximum = Math.min(requested, 10_000);
    const events: RuntimeEvent[] = [];
    let cursor = Math.max(0, query.afterSequence ?? 0);
    let scanned = 0;
    const names = query.names ? new Set(query.names) : null;
    while (events.length <= maximum) {
      const page = await this.runtimeEventPageRows({ sessionId, afterSequence: cursor,
        beforeSequence: null, limit: Math.min(200, maximum + 1 - events.length) });
      for (const entry of page.entries) {
        if (entry.sequence <= cursor) throw new Error("Host event cursor did not advance.");
        cursor = entry.sequence;
        scanned += 1;
        if (scanned > 10_000) throw new Error("Hosted runtime event scan exceeds 10,000 rows; use a narrower query.");
        if (!names || names.has(entry.event.name)) events.push(entry.event);
      }
      if (page.entries.length === 0 || page.remainingMatchingEvents <= page.entries.length) break;
    }
    if (events.length > maximum || (query.limit == null && requested === 10_000 && events.length === maximum)) {
      throw new Error("Hosted runtime event read exceeds 10,000 rows; use a bounded cursor query.");
    }
    return events;
  }

  async persistedRuntimeEventsForSession(sessionId: string, query: {
    afterSequence?: number | null; names?: readonly RuntimeEvent["name"][]; limit?: number | null;
  } = {}): Promise<RuntimeEvent[]> {
    return this.runtimeEventsForSession(sessionId, query);
  }

  async appendRuntimeEvent(value: RuntimeEvent): Promise<RuntimeEvent> {
    const event = RuntimeEventSchema.parse(value);
    const result = await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: event.id,
      operation: "event/append",
      params: { event },
    });
    return z.object({ event: RuntimeEventSchema }).strict().parse(result).event;
  }

  async runtimeEventPageRows(input: {
    sessionId: string | null;
    afterSequence: number;
    beforeSequence: number | null;
    limit: number;
  }): Promise<{
    entries: Array<{ sequence: number; event: RuntimeEvent }>;
    totalMatchingEvents: number;
    remainingMatchingEvents: number;
  }> {
    const limit = Math.max(1, Math.min(1_000, Math.trunc(input.limit)));
    let afterSequence = Math.max(0, Math.trunc(input.afterSequence));
    let beforeSequence = input.beforeSequence;
    let entries: Array<{ sequence: number; event: RuntimeEvent }> = [];
    let totalMatchingEvents = 0;
    let remainingMatchingEvents = 0;
    while (entries.length < limit) {
      const chunkLimit = Math.min(200, limit - entries.length);
      const page = pageSchema.parse(await this.client.request({
        contractVersion: HOST_STORAGE_CONTRACT_VERSION,
        requestId: `event-page:${randomUUID()}`,
        operation: "events/page",
        params: { sessionId: input.sessionId, afterSequence, beforeSequence, limit: chunkLimit },
      }));
      if (entries.length === 0) {
        totalMatchingEvents = page.totalMatchingEvents;
        remainingMatchingEvents = page.remainingMatchingEvents;
      }
      entries = beforeSequence === null
        ? [...entries, ...page.entries]
        : [...page.entries, ...entries];
      if (page.entries.length < chunkLimit || page.entries.length === 0) break;
      if (beforeSequence === null) {
        const next = page.entries.at(-1)!.sequence;
        if (next <= afterSequence) throw new Error("Host event cursor did not advance.");
        afterSequence = next;
      } else {
        const next = page.entries[0]!.sequence;
        if (next >= beforeSequence) throw new Error("Host event cursor did not advance.");
        beforeSequence = next;
      }
    }
    return { entries, totalMatchingEvents, remainingMatchingEvents };
  }
}
