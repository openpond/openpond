import { z } from "zod";

// Display stored evidence without granting training or review authority.
const CaptureSummary = z.object({
  client: z.string(),
  capturedAt: z.string().datetime(),
  trainingUseAuthorized: z.boolean(),
  attempt: z.object({ payload: z.object({
    tool: z.object({ name: z.string() }),
    action: z.unknown(),
  }) }),
  failure: z.object({ payload: z.object({
    message: z.string(),
    exitCode: z.number().nullable(),
    execution: z.string(),
  }) }),
});

export function readCapturedToolError(value: unknown) {
  const parsed = CaptureSummary.safeParse(value);
  return parsed.success ? parsed.data : null;
}
