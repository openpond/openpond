import { z } from "zod";

const Segment = z.string().min(1).max(200).refine(value => !["__proto__", "prototype", "constructor"].includes(value), "Use an ordinary field name.");
const Path = z.array(Segment).min(1).max(20);
const Slot = z.enum(["input", "output", "expectedOutput", "evaluatorContext"]);
export const ExperimentFieldMappingSchema = z.object({
  destination: Slot, path: Path, source: Slot, sourcePath: z.array(Segment).max(20),
}).strict();
export const ExperimentFieldMappingsSchema = z.array(ExperimentFieldMappingSchema).max(100).superRefine((mappings, context) => {
  for (const [index, mapping] of mappings.entries()) {
    if (mappings.slice(0, index).some(previous => previous.destination === mapping.destination
      && (prefix(previous.path, mapping.path) || prefix(mapping.path, previous.path))))
      context.addIssue({ code: "custom", path: [index, "path"], message: "Mapped destination paths must not overlap." });
  }
});
export type ExperimentFieldMapping = z.infer<typeof ExperimentFieldMappingSchema>;
export type ExperimentGradingFields = { input: Record<string, unknown>; output: Record<string, unknown>; expectedOutput: Record<string, unknown> | null; evaluatorContext: Record<string, unknown> | null };

/** Map only grader evidence. The caller must never use this projection as a policy input. */
export function mapExperimentGradingFields(fields: ExperimentGradingFields, raw: readonly ExperimentFieldMapping[]): ExperimentGradingFields {
  const mappings = ExperimentFieldMappingsSchema.parse(raw);
  const mapped = structuredClone(fields);
  for (const mapping of mappings) {
    let value: unknown = fields[mapping.source];
    for (const segment of mapping.sourcePath) {
      if (!record(value) || !Object.hasOwn(value, segment)) throw new Error("The configured grader source field is unavailable.");
      value = value[segment];
    }
    if (value === undefined) throw new Error("The configured grader source field is unavailable.");
    let destination = mapped[mapping.destination];
    if (destination === null) mapped[mapping.destination] = destination = {};
    for (const segment of mapping.path.slice(0, -1)) {
      const existing: unknown = Object.hasOwn(destination, segment) ? destination[segment] : undefined;
      if (existing !== undefined && !record(existing)) throw new Error("A grader destination path crosses a scalar field.");
      if (existing === undefined) destination[segment] = {};
      destination = destination[segment] as Record<string, unknown>;
    }
    destination[mapping.path.at(-1)!] = structuredClone(value);
  }
  return mapped;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function prefix(left: string[], right: string[]) { return left.length <= right.length && left.every((segment, index) => segment === right[index]); }
