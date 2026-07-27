import type {
  ModelToolDefinition,
  ModelToolExecutionContext,
} from "./model-tool-registry.js";
import type { NativeModelToolResult } from "./native-tool-calls.js";

export type OpenPondDatasetBuilderAction =
  | "start"
  | "revise"
  | "answer_questions"
  | "approve_disclosure"
  | "materialize"
  | "cancel"
  | "status"
  | "audit_graders"
  | "calibrate_judges"
  | "baseline"
  | "readiness";

export type RunDatasetBuilder = (
  context: ModelToolExecutionContext,
  action: OpenPondDatasetBuilderAction,
  input: Record<string, unknown>,
) => Promise<unknown>;

export function createDatasetBuilderModelToolDefinitions(
  runDatasetBuilder: RunDatasetBuilder,
): ModelToolDefinition[] {
  return [
    {
      name: "openpond_dataset_design",
      description:
        "Use the built-in Dataset Builder Agent to start or revise a Dataset design, answer its blocking questions, approve disclosure, read status, or cancel. This does not materialize a Dataset or start training.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: [
              "start",
              "revise",
              "answer_questions",
              "approve_disclosure",
              "status",
              "cancel",
            ],
          },
          creationId: { type: "string", minLength: 1 },
          objective: { type: "string", minLength: 1 },
          message: { type: "string", minLength: 1 },
          answers: {
            type: "object",
            additionalProperties: { type: "string" },
          },
          approved: { type: "boolean" },
          buildIntent: {
            type: "string",
            enum: [
              "demonstrations",
              "preferences",
              "verifiable_reward",
              "rubric",
              "discovery",
            ],
          },
          buildSpecification: {
            type: "object",
            additionalProperties: true,
            description:
              "Typed build contract. For the built-in marketing GRPO benchmark, use kind=agent_benchmark, benchmarkId=marketing-portfolio-v1, the marketing-portfolio-manager Agent with its ordered snapshot and decision actions, split-isolated prompt families, and exact 24/8/8 split counts. Do not include private cases or expected decisions.",
          },
          sourceIds: {
            type: "array",
            items: { type: "string" },
            maxItems: 500,
          },
          methodHint: {
            type: "string",
            enum: ["sft", "dpo", "grpo", "ppo"],
          },
          mode: { type: "string", enum: ["defaults", "customize"] },
        },
        required: ["action"],
      },
      execute: async (context) =>
        datasetBuilderToolResult(
          context.callId,
          "openpond_dataset_design",
          await runDatasetBuilder(
            context,
            datasetDesignAction(context.args.action),
            context.args,
          ),
        ),
    },
    {
      name: "openpond_dataset_materialize",
      description:
        "Materialize an approved Dataset design into an immutable Dataset revision. Call only after the user explicitly approves the proposed design and materialization. This does not start training.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          creationId: { type: "string", minLength: 1 },
          approved: {
            type: "boolean",
            const: true,
            description:
              "Must be true and must reflect explicit user approval in this conversation.",
          },
        },
        required: ["creationId", "approved"],
      },
      execute: async (context) => {
        if (context.args.approved !== true) {
          throw new Error(
            "Materialization requires approved=true after explicit user approval.",
          );
        }
        return datasetBuilderToolResult(
          context.callId,
          "openpond_dataset_materialize",
          await runDatasetBuilder(context, "materialize", context.args),
        );
      },
    },
    {
      name: "openpond_dataset_test",
      description:
        "Inspect or test a materialized Dataset with grader audit, model-judge calibration, a bounded train-signal baseline, or readiness. Baselines are evaluations only and never launch training.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: [
              "audit_graders",
              "calibrate_judges",
              "baseline",
              "readiness",
            ],
          },
          tasksetId: { type: "string", minLength: 1 },
          split: {
            type: "string",
            enum: ["train", "validation", "frozen_eval"],
          },
          taskLimit: { type: "integer", minimum: 1, maximum: 100 },
          attemptsPerTask: { type: "integer", minimum: 1, maximum: 16 },
        },
        required: ["action", "tasksetId"],
      },
      execute: async (context) =>
        datasetBuilderToolResult(
          context.callId,
          "openpond_dataset_test",
          await runDatasetBuilder(
            context,
            datasetTestAction(context.args.action),
            context.args,
          ),
        ),
    },
  ];
}

function datasetDesignAction(value: unknown): OpenPondDatasetBuilderAction {
  if (
    value === "start" ||
    value === "revise" ||
    value === "answer_questions" ||
    value === "approve_disclosure" ||
    value === "status" ||
    value === "cancel"
  ) {
    return value;
  }
  throw new Error("Unsupported Dataset design action.");
}

function datasetTestAction(value: unknown): OpenPondDatasetBuilderAction {
  if (
    value === "audit_graders" ||
    value === "calibrate_judges" ||
    value === "baseline" ||
    value === "readiness"
  ) {
    return value;
  }
  throw new Error("Unsupported Dataset test action.");
}

function datasetBuilderToolResult(
  callId: string,
  name: string,
  result: unknown,
): NativeModelToolResult {
  return {
    toolCallId: callId,
    name,
    ok: true,
    contentText: JSON.stringify(
      {
        ok: true,
        action: name,
        output: "Dataset Builder Agent action completed.",
        data: { result },
      },
      null,
      2,
    ),
    data: { result },
  };
}
