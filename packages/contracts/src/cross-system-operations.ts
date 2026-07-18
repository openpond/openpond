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

export const CROSS_SYSTEM_BOOTSTRAP_SYSTEM_PROMPT = [
  `Use only the four registered synthetic Cross-System Operations tools. Contract ${CROSS_SYSTEM_TOOL_CONTRACT_HASH}.`,
  "Treat every filter as exact. An overdue-only query_billing call returns invoice rows; payment rows are included only when paid is requested.",
  "For cross-system joins, retrieve the bounded projected rows and use run_python for date filtering, set intersection, and arithmetic before answering.",
  "Finish with ANSWER: JSON.",
].join(" ");
export const CROSS_SYSTEM_LOCAL_TOOL_MAX_TURNS = 15;

export function crossSystemLocalToolSystemPrompt(toolChoice: unknown = "auto"): string {
  return [
    CROSS_SYSTEM_BOOTSTRAP_SYSTEM_PROMPT,
    "LOCAL TOOL PROTOCOL (strict):",
    "Use only the registered functions below. Never invent, rename, or call any other tool.",
    "For one tool call, output exactly one JSON object and no prose:",
    '{"type":"tool_call","name":"registered_name","arguments":{}}',
    "Tool results arrive as exactly one JSON object:",
    '{"type":"tool_result","name":"registered_name","ok":true,"result":{},"error":null}',
    'After one tool result, either call one registered tool again or answer normally. A JSON final may use {"type":"final","content":"..."}.',
    `Tool choice: ${JSON.stringify(toolChoice)}. Maximum tool turns: ${CROSS_SYSTEM_LOCAL_TOOL_MAX_TURNS}.`,
    `Registered tool signatures: ${CROSS_SYSTEM_TOOL_DEFINITIONS.map(compactToolSignature).join("; ")}`,
  ].join("\n");
}

export const CROSS_SYSTEM_LOCAL_TOOL_SYSTEM_PROMPT = crossSystemLocalToolSystemPrompt();

function compactToolSignature(tool: (typeof CROSS_SYSTEM_TOOL_DEFINITIONS)[number]): string {
  const parameters = recordValue(tool.parameters);
  const properties = recordValue(parameters.properties);
  const required = stringValues(parameters.required);
  const shape = Object.fromEntries(required.map((name) => [name, compactSchema(properties[name])]));
  return `${tool.name}(${JSON.stringify(shape)})`;
}

function compactSchema(value: unknown): unknown {
  const schema = recordValue(value);
  const anyOf = arrayValue(schema.anyOf);
  if (anyOf.length) return anyOf.map(compactSchema).join("|");
  const enumValues = arrayValue(schema.enum);
  if (enumValues.length) return enumValues.join("|");
  if (schema.type === "array") return [compactSchema(schema.items)];
  if (schema.type === "object") {
    const properties = recordValue(schema.properties);
    const required = stringValues(schema.required);
    return Object.fromEntries(required.map((name) => [name, compactSchema(properties[name])]));
  }
  return typeof schema.type === "string" ? schema.type : "unknown";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValues(value: unknown): string[] {
  return arrayValue(value).filter((item): item is string => typeof item === "string");
}

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

export const CrossSystemExpertBootstrapTaskPreviewSchema = z.object({
  tasksetTaskId: z.string().trim().min(1).max(240),
  environmentTaskId: z.string().trim().min(1).max(240),
  family: z.enum([
    "renewal_exposure",
    "collections_prioritization",
    "invoice_reconciliation",
    "sla_escalation",
    "contract_billing_mismatch",
  ]),
  prompt: z.string().trim().min(1).max(100_000),
  finalAnswer: z.string().trim().min(1).max(200_000),
  trajectoryId: z.string().trim().min(1).max(240),
  trajectoryHash: z.string().trim().min(8).max(256),
  toolNames: z.array(CrossSystemToolNameSchema).min(1).max(100),
  toolCallCount: z.number().int().positive(),
  messageCount: z.number().int().min(3),
  reward: z.number().min(0).max(1.15),
  messages: z.array(CrossSystemBootstrapMessageSchema).min(3).max(1_000),
});

export const CrossSystemExpertBootstrapApprovalSchema = z.object({
  status: z.literal("approved"),
  approvedBy: z.string().trim().min(1).max(240),
  approvedAt: z.string().trim().min(1),
  previewHash: z.string().trim().min(8).max(256),
  trajectoryCount: z.number().int().positive(),
});

export const CrossSystemExpertBootstrapPreviewSchema = z.object({
  schemaVersion: z.literal("openpond.crossSystemExpertBootstrapPreview.v1"),
  tasksetId: z.string().trim().min(1).max(240),
  tasksetHash: z.string().trim().min(8).max(256),
  tasksetRevision: z.number().int().positive(),
  previewHash: z.string().trim().min(8).max(256),
  toolContractHash: z.literal(CROSS_SYSTEM_TOOL_CONTRACT_HASH),
  status: z.enum(["ready_for_review", "approved"]),
  approval: CrossSystemExpertBootstrapApprovalSchema.nullable(),
  tasks: z.array(CrossSystemExpertBootstrapTaskPreviewSchema).min(1).max(100),
});

export type CrossSystemTrajectoryStep = z.infer<typeof CrossSystemTrajectoryStepSchema>;
export type CrossSystemTrajectory = z.infer<typeof CrossSystemTrajectorySchema>;
export type CrossSystemVerifierResult = z.infer<typeof CrossSystemVerifierResultSchema>;
export type CrossSystemBootstrapMessage = z.infer<typeof CrossSystemBootstrapMessageSchema>;
export type CrossSystemBootstrapRecord = z.infer<typeof CrossSystemBootstrapRecordSchema>;
export type CrossSystemExpertBootstrapTaskPreview = z.infer<typeof CrossSystemExpertBootstrapTaskPreviewSchema>;
export type CrossSystemExpertBootstrapApproval = z.infer<typeof CrossSystemExpertBootstrapApprovalSchema>;
export type CrossSystemExpertBootstrapPreview = z.infer<typeof CrossSystemExpertBootstrapPreviewSchema>;

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
