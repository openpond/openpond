import { randomUUID } from "node:crypto";
import { RuntimeEventSchema, TurnSchema, type RuntimeEvent, type Turn } from "@openpond/contracts";
import {
  HOST_STORAGE_CONTRACT_VERSION,
  type AgentHostStorageClient,
} from "@openpond/agent-runtime";
import { z } from "zod";

const turnPageSchema = z.object({
  turns: z.array(TurnSchema).max(200),
  nextBeforeSortIndex: z.number().int().nonnegative().nullable(),
}).strict();
const eventPageSchema = z.object({
  entries: z.array(z.object({ sequence: z.number().int().positive(), event: RuntimeEventSchema })).max(200),
  totalMatchingEvents: z.number().int().nonnegative(),
  remainingMatchingEvents: z.number().int().nonnegative(),
}).strict();

/** Bounded read of the canonical host history for a single admitted thread. */
export async function hostedTurnsForSession(
  client: AgentHostStorageClient,
  sessionId: string,
  maximum = 1_000,
): Promise<Turn[]> {
  const turns: Turn[] = [];
  let beforeSortIndex: number | null = null;
  while (turns.length < maximum) {
    const page = turnPageSchema.parse(await client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: randomUUID(),
      operation: "thread/turnPage",
      params: { sessionId, beforeSortIndex, limit: Math.min(200, maximum - turns.length) },
    }));
    turns.push(...page.turns);
    if (!page.nextBeforeSortIndex) return turns;
    if (page.nextBeforeSortIndex === beforeSortIndex) throw new Error("Host history cursor did not advance.");
    beforeSortIndex = page.nextBeforeSortIndex;
  }
  return turns;
}

export async function hostedRuntimeEventsForSession(
  client: AgentHostStorageClient,
  sessionId: string,
  maximum = 1_000,
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  let afterSequence = 0;
  while (events.length < maximum) {
    const page = eventPageSchema.parse(await client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: randomUUID(),
      operation: "events/page",
      params: { sessionId, afterSequence, limit: Math.min(200, maximum - events.length) },
    }));
    events.push(...page.entries.map((entry) => entry.event));
    if (page.entries.length === 0 || page.entries.length >= page.remainingMatchingEvents) return events;
    const next = page.entries.at(-1)!.sequence;
    if (next <= afterSequence) throw new Error("Host event cursor did not advance.");
    afterSequence = next;
  }
  return events;
}
