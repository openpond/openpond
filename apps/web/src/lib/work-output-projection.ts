import { OutputRefSchema, type OutputRef, type RuntimeEvent } from "@openpond/contracts";

const outputKinds = new Set(OutputRefSchema.options.map(schema => schema.shape.kind.value));
const eventOutputs = new WeakMap<RuntimeEvent, { data: unknown; outputs: OutputRef[] }>();

/** Runtime events are immutable. Reuse their validated outputs as new events arrive. */
export function workOutputsFromEvents(events: readonly RuntimeEvent[]): OutputRef[] {
  const outputs = new Map<string, OutputRef>();
  const deleted = new Set<string>();
  for (const event of events) {
    if (event.action === "work_output_read") continue;
    let cached = eventOutputs.get(event);
    if (!cached || cached.data !== event.data) {
      const refs: OutputRef[] = [];
      collectOutputRefs(event.data, refs, new Set());
      cached = { data: event.data, outputs: refs };
      eventOutputs.set(event, cached);
    }
    if (event.action === "work_output_delete" && event.status === "completed") {
      for (const output of cached.outputs) {
        const key = `${output.id}:${output.revision}`;
        deleted.add(key);
        outputs.delete(key);
      }
      continue;
    }
    for (const output of cached.outputs) {
      const key = `${output.id}:${output.revision}`;
      if (!deleted.has(key)) outputs.set(key, output);
    }
  }
  return [...outputs.values()].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || right.revision - left.revision,
  );
}

function collectOutputRefs(value: unknown, outputs: OutputRef[], seen: Set<string>, depth = 0): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectOutputRefs(item, outputs, seen, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  // Most event data is command text, timings or provider metadata. Only objects
  // with an output discriminant need schema validation and its error allocation.
  if (outputKinds.has(record.kind as OutputRef["kind"])) {
    const parsed = OutputRefSchema.safeParse(record);
    if (parsed.success) {
      const key = `${parsed.data.id}:${parsed.data.revision}`;
      if (!seen.has(key)) { seen.add(key); outputs.push(parsed.data); }
      return;
    }
  }
  for (const child of Object.values(record)) collectOutputRefs(child, outputs, seen, depth + 1);
}
