import { z } from "zod";
import { ReleaseIdSchema } from "@openpond/harness";
import {
  assertLearningRequestJson,
  LearningCommandSchema,
  LearningResourceKindSchema,
  type OpenPondLearningClient,
} from "openpond-sdk/learning";

export const LearningCliBatchSchema = z.array(z.discriminatedUnion("action", [
  z.object({
    action: z.literal("get"), kind: LearningResourceKindSchema,
    id: ReleaseIdSchema, revision: z.number().int().positive().optional(),
  }).strict(),
  z.object({ action: z.literal("command"), command: LearningCommandSchema }).strict(),
])).min(1).max(100);

type BatchResult = { index: number } & (
  | { status: "not_started" }
  | { status: "completed"; result: unknown }
  | { status: "request_failed"; error: { code: string; message: string } }
);

/** Validate every operation before dispatch. A failed request stops new work,
 * but all dispatched requests settle; writes are never automatically retried. */
export async function executeLearningCliBatch(
  client: Pick<OpenPondLearningClient, "command" | "get">,
  input: unknown,
  concurrency = 1,
) {
  assertLearningRequestJson(input);
  const operations = LearningCliBatchSchema.parse(input);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw new Error("Learning batch concurrency must be an integer from 1 to 4.");
  const results: BatchResult[] = operations.map((_, index) => ({ index, status: "not_started" }));
  let next = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(concurrency, operations.length) }, async () => {
    while (!failed && next < operations.length) {
      const index = next++;
      const operation = operations[index]!;
      try {
        const result = operation.action === "command"
          ? await client.command(operation.command)
          : await client.get(operation.kind, operation.id, operation.revision);
        results[index] = { index, status: "completed", result };
      } catch (error) {
        failed = true;
        results[index] = { index, status: "request_failed", error: {
          code: error instanceof Error && "code" in error && typeof error.code === "string"
            ? error.code : "learning_request_failed",
          message: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
        } };
      }
    }
  }));
  return { schemaVersion: "openpond.cliLearningBatch.v1" as const, ok: !failed, results };
}
