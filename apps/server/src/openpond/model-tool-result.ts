import type { WorkspaceToolResult } from "@openpond/contracts";

import { formatWorkspaceToolResultForModel } from "./hosted-tool-protocol.js";
import type { NativeModelToolResult } from "./native-tool-calls.js";
import { toolOutputResourceRef } from "./tool-output-spill.js";

/**
 * Keeps the model-facing representation bounded while linking the durable
 * runtime event to its full output for later resource reads.
 */
export function workspaceToolResultToModelToolResult(
  callId: string,
  name: string,
  result: WorkspaceToolResult,
): NativeModelToolResult {
  const outputResourceRef = toolOutputResourceRef(callId);
  const resultData = result.data && typeof result.data === "object" && !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : { result: result.data ?? null };
  return {
    toolCallId: callId,
    name,
    ok: result.ok,
    contentText: formatWorkspaceToolResultForModel(result, { outputResourceRef }),
    data: { ...resultData, outputResourceRef },
  };
}
