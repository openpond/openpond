import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  FileOutputRefSchema,
  workOutputMediaTypesCompatible,
  type ChatModelRef,
  type FileOutputRef,
  type Session,
  type TaskRequiredOutput,
  type Taskset,
} from "@openpond/contracts";

import type { NativeModelToolResult } from "../openpond/native-tool-calls.js";
import type {
  ModelToolDefinition,
  ModelToolExecutionContext,
} from "../openpond/model-tool-registry.js";

const DEFAULT_MAX_WORK_TOOL_TURNS = 24;
const MAX_WORK_TOOL_TURNS = 100;
const MAX_MISSING_OUTPUT_RECOVERY_TURNS = 10;
const MAX_WORK_MODEL_REQUEST_TIMEOUT_MS = 20 * 60_000;
const MAX_WORK_EXEC_TIMEOUT_SECONDS = 20 * 60;

export type TasksetWorkRequiredOutputValidator = (input: {
  requiredOutput: TaskRequiredOutput;
  outputRef: FileOutputRef;
  artifactPath: string;
}) => Promise<{ passed: boolean; detail: string }>;

export type SavedWorkOutput = {
  relativePath: string;
  outputRef: FileOutputRef;
  artifactPath: string;
};

export type SavedOutputValidation = {
  passed: boolean;
  detail: string;
  parsedJson?: unknown;
};

export async function executeDefinition(input: {
  definition: ModelToolDefinition;
  runtime: {
    getSession(sessionId: string): Promise<Session>;
  };
  sessionId: string;
  turnId: string;
  model: ChatModelRef;
  callId: string;
  args: Record<string, unknown>;
  signal: AbortSignal;
  userPrompt: string;
}): Promise<NativeModelToolResult> {
  const session = await input.runtime.getSession(input.sessionId);
  const context: ModelToolExecutionContext = {
    session,
    turnId: input.turnId,
    turnPermissions: {
      approvalPolicy: "never",
      sandbox: "workspace-write",
      codexPermissionMode: "auto-review",
      codexReasoningEffort: "high",
    },
    provider: input.model.providerId,
    model: input.model.modelId,
    callId: input.callId,
    args: input.args,
    signal: input.signal,
    workspaceDiffBaseline: null,
    mentionedApps: [],
    userPrompt: input.userPrompt,
    turnMetadata: {
      automatedTasksetWorkAttempt: true,
    },
  };
  try {
    return await input.definition.execute(context);
  } catch (error) {
    return {
      toolCallId: input.callId,
      name: input.definition.name,
      ok: false,
      contentText: JSON.stringify({
        ok: false,
        action: input.definition.name,
        output: errorMessage(error),
      }),
    };
  }
}

export function savedWorkOutput(
  args: Record<string, unknown>,
  result: NativeModelToolResult,
): SavedWorkOutput | null {
  if (!result.ok || result.name !== "work_save_output") return null;
  const data = asRecord(result.data);
  const parsed = FileOutputRefSchema.safeParse(data.outputRef);
  const artifact = asRecord(data.artifact);
  const artifactPath =
    typeof artifact.path === "string" ? artifact.path : null;
  const relativePath =
    typeof args.path === "string" ? normalizedOutputPath(args.path) : null;
  if (!parsed.success || !artifactPath || !relativePath) return null;
  return {
    relativePath,
    outputRef: parsed.data,
    artifactPath,
  };
}

export async function validateSavedOutput(input: {
  requiredOutput: TaskRequiredOutput;
  saved: SavedWorkOutput;
  validateRequiredOutput?: TasksetWorkRequiredOutputValidator;
}): Promise<SavedOutputValidation> {
  if (!workOutputMediaTypesCompatible(
    input.requiredOutput.mediaType,
    input.saved.outputRef.contentType,
  )) {
    return {
      passed: false,
      detail:
        `Expected ${input.requiredOutput.mediaType}, received `
        + `${input.saved.outputRef.contentType}.`,
    };
  }
  if (
    input.requiredOutput.maxBytes !== undefined
    && input.saved.outputRef.sizeBytes > input.requiredOutput.maxBytes
  ) {
    return {
      passed: false,
      detail:
        `Output exceeds the ${input.requiredOutput.maxBytes} byte task limit.`,
    };
  }
  let parsedJson: unknown;
  if (input.requiredOutput.metadata.includeParsedJsonInAttempt === true) {
    if (input.requiredOutput.mediaType !== "application/json") {
      return {
        passed: false,
        detail:
          "Only application/json outputs may expose parsed content to the Taskset grader.",
      };
    }
    if (input.saved.outputRef.sizeBytes > 1_000_000) {
      return {
        passed: false,
        detail:
          "Parsed Taskset grader content exceeds the 1,000,000 byte safety limit.",
      };
    }
    try {
      parsedJson = JSON.parse(
        await readFile(input.saved.artifactPath, "utf8"),
      );
    } catch {
      return {
        passed: false,
        detail: "Required JSON output could not be parsed.",
      };
    }
  }
  if (input.validateRequiredOutput) {
    const validation = await input.validateRequiredOutput({
      requiredOutput: input.requiredOutput,
      outputRef: input.saved.outputRef,
      artifactPath: input.saved.artifactPath,
    });
    return {
      ...validation,
      ...(parsedJson !== undefined ? { parsedJson } : {}),
    };
  }
  return {
    passed: true,
    detail: input.requiredOutput.schemaRef
      ? `Structure and media type passed; schema ${input.requiredOutput.schemaRef} is enforced by the Taskset grader.`
      : "Structure and media type passed.",
    ...(parsedJson !== undefined ? { parsedJson } : {}),
  };
}

export function workToolTurnLimit(taskset: Taskset): number {
  const configured = taskset.environment.metadata.maxToolTurns;
  return typeof configured === "number"
    && Number.isInteger(configured)
    && configured > 0
    ? Math.min(configured, MAX_WORK_TOOL_TURNS)
    : DEFAULT_MAX_WORK_TOOL_TURNS;
}

export function workMissingOutputRecoveryTurnLimit(taskset: Taskset): number {
  const configured = taskset.environment.metadata.missingOutputRecoveryTurns;
  return typeof configured === "number"
    && Number.isInteger(configured)
    && configured > 0
    ? Math.min(configured, MAX_MISSING_OUTPUT_RECOVERY_TURNS)
    : 0;
}

export function workModelRequestTimeoutMs(taskset: Taskset): number | null {
  const configured = taskset.environment.metadata.modelRequestTimeoutMs;
  return typeof configured === "number"
    && Number.isInteger(configured)
    && configured > 0
    ? Math.min(configured, MAX_WORK_MODEL_REQUEST_TIMEOUT_MS)
    : null;
}

export function workExecTimeoutSeconds(taskset: Taskset): number | null {
  const configured = taskset.environment.metadata.maxExecTimeoutSeconds;
  return typeof configured === "number"
    && Number.isInteger(configured)
    && configured > 0
    ? Math.min(configured, MAX_WORK_EXEC_TIMEOUT_SECONDS)
    : null;
}

function normalizedOutputPath(value: string): string | null {
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/")) return null;
  const clean = path.posix.normalize(normalized);
  if (
    clean === "."
    || clean === ".."
    || clean.startsWith("../")
    || clean.split("/").includes("..")
  ) {
    return null;
  }
  return clean.startsWith("outputs/") ? clean.slice("outputs/".length) : clean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
