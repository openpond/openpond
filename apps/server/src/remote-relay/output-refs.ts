import type { FileOutputRef, Session } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import { createOutputReferenceAccumulator } from "../work/output-references.js";

/** Requested tasks only; page canonical events and bound retained reference metadata. */
export function createRemoteOutputReader(store: Pick<SqliteStore, "runtimeEventPageRows" | "latestEventSequence">) {
  const cache = new Map<string, { watermark: number; outputs: FileOutputRef[]; bytes: number }>();
  let retainedBytes = 0;
  return async (session: Session) => {
    if (session.experience !== "work") return [];
    const watermark = await store.latestEventSequence();
    const existing = cache.get(session.id);
    if (existing?.watermark === watermark) { cache.delete(session.id); cache.set(session.id, existing); return existing.outputs; }
    const refs = createOutputReferenceAccumulator(5000);
    let after = 0;
    while (after < watermark) {
      const page = await store.runtimeEventPageRows({ sessionId: session.id, afterSequence: after, beforeSequence: null, limit: 100 });
      const entries = page.entries.filter(entry => entry.sequence <= watermark);
      for (const entry of entries) refs.accept(entry.event);
      if (entries.length < 100) break;
      after = entries.at(-1)!.sequence;
    }
    const outputs = refs.values().filter(output => output.sourceTaskId === session.id && output.location.kind === "local")
      .sort((a, b) => b.revision - a.revision);
    const bytes = Buffer.byteLength(JSON.stringify(outputs));
    if (bytes > 10_485_760) throw new Error("remote_output_reference_limit");
    if (existing) { retainedBytes -= existing.bytes; cache.delete(session.id); }
    while (cache.size >= 20 || retainedBytes + bytes > 33_554_432) {
      const first = cache.entries().next().value;
      if (!first) break;
      cache.delete(first[0]); retainedBytes -= first[1].bytes;
    }
    cache.set(session.id, { watermark, outputs, bytes }); retainedBytes += bytes;
    return outputs;
  };
}
