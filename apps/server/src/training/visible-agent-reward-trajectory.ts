import { z } from "zod";

const JsonRecordSchema = z.record(z.string(), z.unknown());

const VisibleConversationTurnSchema = z.object({
  index: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant", "tool", "system_event"]),
  name: z.string().trim().min(1).max(200).nullable().default(null),
  content: z.string().max(50_000).nullable(),
}).strict();

const VisibleToolEventSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(200),
  arguments: JsonRecordSchema,
  result: JsonRecordSchema.nullable(),
  status: z.enum(["succeeded", "failed", "timed_out", "rejected"]),
}).strict();

export const VisibleAgentTrajectorySchema = z.object({
  schemaVersion: z.literal("openpond.visibleAgentTrajectory.v1"),
  conversation: z.array(VisibleConversationTurnSchema).min(1).max(500),
  toolEvents: z.array(VisibleToolEventSchema).max(500),
  runtimeEvents: z.array(z.object({
    index: z.number().int().nonnegative(),
    type: z.string().trim().min(1).max(200),
    detail: JsonRecordSchema,
  }).strict()).max(1_000),
  finalVisibleState: JsonRecordSchema,
  escalation: z.object({
    requested: z.boolean(),
    reason: z.string().trim().min(1).max(5_000).nullable(),
    handoff: z.string().trim().min(1).max(20_000).nullable(),
  }).strict(),
  termination: z.object({
    terminal: z.boolean(),
    truncated: z.boolean(),
    reason: z.string().trim().min(1).max(1_000),
  }).strict(),
}).strict().superRefine((trajectory, context) => {
  const forbidden = findForbiddenScorerKey(trajectory);
  if (forbidden) {
    context.addIssue({
      code: "custom",
      path: forbidden.path,
      message: `Agent scorer input contains forbidden privileged field ${forbidden.key}.`,
    });
  }
});

export type VisibleAgentTrajectory = z.infer<typeof VisibleAgentTrajectorySchema>;

export function assertPolicyVisibleAgentScorerEvidence(
  value: unknown,
  label = "Agent scorer input",
): void {
  const forbidden = findForbiddenScorerKey(value);
  if (forbidden) {
    throw new Error(
      `${label} contains forbidden privileged field ${forbidden.key}.`,
    );
  }
}

const FORBIDDEN_KEYS = new Set([
  "expectedanswer",
  "expectedoutput",
  "expectedterminalstate",
  "hiddenobjective",
  "privilegedcontext",
  "privilegedgraderfields",
  "reward",
  "score",
]);

function findForbiddenScorerKey(
  value: unknown,
  path: Array<string | number> = [],
): { key: string; path: Array<string | number> } | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findForbiddenScorerKey(item, [...path, index]);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.replaceAll(/[^A-Za-z0-9]/g, "").toLowerCase())) {
      return { key, path: [...path, key] };
    }
    const found = findForbiddenScorerKey(item, [...path, key]);
    if (found) return found;
  }
  return null;
}
