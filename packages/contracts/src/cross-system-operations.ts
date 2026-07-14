import { z } from "zod";

export const CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION = "openpond.crossSystemOperations.v1" as const;
export const CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION = "1.0.0" as const;
export const CROSS_SYSTEM_TOOL_CONTRACT_VERSION = "openpond.crossSystemTools.v1" as const;
export const CROSS_SYSTEM_TOOL_NAMES = [
  "search_crm",
  "query_billing",
  "search_support",
  "run_python",
] as const;

export type CrossSystemToolName = (typeof CROSS_SYSTEM_TOOL_NAMES)[number];

const cursor = {
  anyOf: [{ type: "string", minLength: 1, maxLength: 256 }, { type: "null" }],
  default: null,
} as const;
const limit = { type: "integer", minimum: 1, maximum: 50, default: 25 } as const;

export const CROSS_SYSTEM_TOOL_DEFINITIONS = [
  {
    name: "search_crm",
    description: "Search synthetic CRM accounts and contacts. Results are scoped, projected, paginated, and budgeted.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query", "fields", "cursor", "limit"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        fields: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          uniqueItems: true,
          items: {
            type: "string",
            enum: [
              "account_id",
              "name",
              "aliases",
              "contact_ids",
              "contract_value_usd_cents",
              "renewal_date",
              "tier",
              "active_contract_id",
              "contract_term_months",
            ],
          },
        },
        cursor,
        limit,
      },
    },
  },
  {
    name: "query_billing",
    description: "Query synthetic invoices and payments for explicit account IDs and a bounded date range.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["account_ids", "date_range", "status", "cursor", "limit"],
      properties: {
        account_ids: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 100 },
        },
        date_range: {
          type: "object",
          additionalProperties: false,
          required: ["from", "to"],
          properties: {
            from: { type: "string", format: "date" },
            to: { type: "string", format: "date" },
          },
        },
        status: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          uniqueItems: true,
          items: { type: "string", enum: ["open", "overdue", "paid", "disputed", "scheduled", "void"] },
        },
        cursor,
        limit,
      },
    },
  },
  {
    name: "search_support",
    description: "Search synthetic support cases for explicit account IDs, severity, and state filters.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["account_ids", "severity", "state", "cursor", "limit"],
      properties: {
        account_ids: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 100 },
        },
        severity: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          uniqueItems: true,
          items: { type: "string", enum: ["P1", "P2", "P3", "P4"] },
        },
        state: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          uniqueItems: true,
          items: { type: "string", enum: ["new", "investigating", "waiting_customer", "resolved", "closed"] },
        },
        cursor,
        limit,
      },
    },
  },
  {
    name: "run_python",
    description: "Run standard-library-only Python in the persistent synthetic attempt sandbox with strict limits and no network.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["code"],
      properties: {
        code: { type: "string", minLength: 1, maxLength: 10_000 },
      },
    },
  },
] as const;

export const CROSS_SYSTEM_TOOL_CONTRACT_HASH = contractHash({
  schemaVersion: CROSS_SYSTEM_TOOL_CONTRACT_VERSION,
  tools: CROSS_SYSTEM_TOOL_DEFINITIONS,
});

const CrossSystemToolNameSchema = z.enum(CROSS_SYSTEM_TOOL_NAMES);

export const CrossSystemTrajectoryStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("model"),
    turn: z.number().int().nonnegative(),
    content: z.string().max(100_000),
  }),
  z.object({
    kind: z.literal("tool_call"),
    turn: z.number().int().nonnegative(),
    callId: z.string().trim().min(1).max(240),
    name: CrossSystemToolNameSchema,
    arguments: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal("tool_result"),
    turn: z.number().int().nonnegative(),
    callId: z.string().trim().min(1).max(240),
    name: CrossSystemToolNameSchema,
    ok: z.boolean(),
    result: z.unknown(),
    rows: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    error: z.string().trim().min(1).max(20_000).nullable(),
  }),
  z.object({
    kind: z.literal("final"),
    turn: z.number().int().nonnegative(),
    content: z.string().max(100_000),
  }),
]);

export const CrossSystemTrajectorySchema = z.object({
  schemaVersion: z.literal(CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION),
  id: z.string().trim().min(1).max(240),
  worldId: z.string().trim().min(1).max(240),
  taskId: z.string().trim().min(1).max(240),
  toolContractHash: z.literal(CROSS_SYSTEM_TOOL_CONTRACT_HASH),
  modelRef: z.object({ providerId: z.string().trim().min(1), modelId: z.string().trim().min(1) }).nullable(),
  status: z.enum(["completed", "budget_exhausted", "cancelled", "infrastructure_failure"]),
  steps: z.array(CrossSystemTrajectoryStepSchema).max(1_000),
  startedAt: z.string().trim().min(1),
  completedAt: z.string().trim().min(1),
  infrastructureError: z.string().trim().min(1).max(20_000).nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const CrossSystemVerifierResultSchema = z.object({
  schemaVersion: z.literal(CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION),
  trajectoryId: z.string().trim().min(1).max(240),
  outcome: z.enum([
    "correct",
    "incorrect",
    "parse_failure",
    "budget_exhausted",
    "tool_schema_violation",
    "infrastructure_failure",
    "cancelled",
  ]),
  reward: z.number().min(0).max(1.15).nullable(),
  rewardEligible: z.boolean(),
  exactAnswer: z.boolean(),
  components: z.object({
    exactAnswer: z.number().min(0).max(1),
    efficiency: z.number().min(0).max(0.1),
    conciseOutput: z.number().min(0).max(0.05),
  }),
  metrics: z.object({
    toolCalls: z.number().int().nonnegative(),
    rowsRead: z.number().int().nonnegative(),
    bytesRead: z.number().int().nonnegative(),
    consecutiveRetrievalCalls: z.number().int().nonnegative(),
    wallTimeMs: z.number().int().nonnegative(),
    parseFailures: z.number().int().nonnegative(),
    budgetExhausted: z.boolean(),
  }),
  parsedAnswer: z.unknown().nullable(),
  feedback: z.array(z.string().trim().min(1).max(5_000)).max(100),
});

const StructuredToolCallSchema = z.object({
  id: z.string().trim().min(1).max(240),
  type: z.literal("function"),
  function: z.object({
    name: CrossSystemToolNameSchema,
    arguments: z.string().max(20_000),
  }),
});

export const CrossSystemBootstrapMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().max(200_000).nullable(),
  tool_call_id: z.string().trim().min(1).max(240).optional(),
  tool_calls: z.array(StructuredToolCallSchema).max(4).optional(),
});

export const CrossSystemBootstrapRecordSchema = z.object({
  schemaVersion: z.literal(CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION),
  id: z.string().trim().min(1).max(240),
  taskId: z.string().trim().min(1).max(240),
  worldId: z.string().trim().min(1).max(240),
  trajectoryId: z.string().trim().min(1).max(240),
  toolContractHash: z.literal(CROSS_SYSTEM_TOOL_CONTRACT_HASH),
  approval: z.object({
    status: z.literal("approved"),
    approvedBy: z.string().trim().min(1).max(240),
    approvedAt: z.string().trim().min(1),
  }),
  messages: z.array(CrossSystemBootstrapMessageSchema).min(3).max(1_000),
});

export type CrossSystemTrajectoryStep = z.infer<typeof CrossSystemTrajectoryStepSchema>;
export type CrossSystemTrajectory = z.infer<typeof CrossSystemTrajectorySchema>;
export type CrossSystemVerifierResult = z.infer<typeof CrossSystemVerifierResultSchema>;
export type CrossSystemBootstrapMessage = z.infer<typeof CrossSystemBootstrapMessageSchema>;
export type CrossSystemBootstrapRecord = z.infer<typeof CrossSystemBootstrapRecordSchema>;

function contractHash(value: unknown): string {
  const text = stableJson(value);
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${CROSS_SYSTEM_TOOL_CONTRACT_VERSION}:${hex(left)}${hex(right)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}
