import { z } from "zod";

export const JavaScriptVerifierResultSchema = z.object({
  score: z.number().finite().min(0).max(1),
  passed: z.boolean(),
  feedback: z.string().max(20_000),
  evidenceRefs: z.array(z.string().max(240)).max(1_000).default([]),
}).strict();
export type JavaScriptVerifierResult = z.infer<typeof JavaScriptVerifierResultSchema>;
