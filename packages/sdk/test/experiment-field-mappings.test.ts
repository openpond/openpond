import { expect, it } from "vitest";
import { ExperimentFieldMappingsSchema, mapExperimentGradingFields } from "../src/experiment-field-mappings.js";

// A mapping must never leak private evidence by mutating the original policy
// input, manufacture a missing reference, or write into an object's prototype.
it("maps private grader evidence without mutating source fields or manufacturing missing data", () => {
  const fields = { input: { prompt: "Question" }, output: { text: "Answer" }, expectedOutput: { answer: "Reference" }, evaluatorContext: null };
  const mapped = mapExperimentGradingFields(fields, [
    { destination: "output", path: ["answer"], source: "output", sourcePath: ["text"] },
    { destination: "evaluatorContext", path: ["reference"], source: "expectedOutput", sourcePath: ["answer"] },
  ]);
  expect(mapped.output.answer).toBe("Answer");
  expect(mapped.evaluatorContext).toEqual({ reference: "Reference" });
  expect(fields.output).toEqual({ text: "Answer" });
  expect(fields.input).toEqual({ prompt: "Question" });
  expect(fields.evaluatorContext).toBeNull();
  expect(() => mapExperimentGradingFields(fields, [{ destination: "input", path: ["answer"], source: "expectedOutput", sourcePath: ["missing"] }])).toThrow("unavailable");
  expect(ExperimentFieldMappingsSchema.safeParse([{ destination: "input", path: ["__proto__", "private"], source: "expectedOutput", sourcePath: [] }]).success).toBe(false);
  expect(ExperimentFieldMappingsSchema.safeParse([
    { destination: "output", path: ["answer"], source: "output", sourcePath: [] },
    { destination: "output", path: ["answer", "text"], source: "output", sourcePath: [] },
  ]).success).toBe(false);
});
