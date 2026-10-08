import { FileOutputRefSchema, type FileOutputRef, type RuntimeEvent } from "@openpond/contracts";

export function activeFileOutputRefs(events: RuntimeEvent[]): FileOutputRef[] {
  const accumulator = createOutputReferenceAccumulator();
  for (const event of events) accumulator.accept(event);
  return accumulator.values();
}

export function createOutputReferenceAccumulator(maxRefs = Number.POSITIVE_INFINITY) {
  const outputs = new Map<string, FileOutputRef>();
  const deleted = new Set<string>();
  function accept(event: RuntimeEvent) {
    const refs = fileOutputRefs(event.data);
    if (outputs.size + deleted.size + refs.length > maxRefs) throw new Error("remote_output_reference_limit");
    if (event.action === "work_output_delete" && event.status === "completed") {
      for (const output of refs) {
        const key = fileOutputRevisionKey(output);
        deleted.add(key);
        outputs.delete(key);
      }
      return;
    }
    if (event.action === "work_output_read") return;
    for (const output of refs) {
      const key = fileOutputRevisionKey(output);
      if (!deleted.has(key)) outputs.set(key, output);
    }
  }
  return { accept, values: () => [...outputs.values()] };
}

function fileOutputRevisionKey(output: FileOutputRef): string {
  return `${output.sourceTaskId}:${output.id}:${output.revision}`;
}

export function fileOutputRefs(value: unknown, depth = 0): FileOutputRef[] {
  if (depth > 8 || value == null) return [];
  const parsed = FileOutputRefSchema.safeParse(value);
  if (parsed.success) return [parsed.data];
  if (Array.isArray(value)) {
    return value.flatMap((item) => fileOutputRefs(item, depth + 1));
  }
  const record = asRecord(value);
  return Object.values(record).flatMap((child) =>
    fileOutputRefs(child, depth + 1)
  );
}


function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
