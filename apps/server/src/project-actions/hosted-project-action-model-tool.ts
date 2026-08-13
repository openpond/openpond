import type { OpenPondActionCatalogEntry } from "@openpond/contracts";

import type { NativeModelToolResult } from "../openpond/native-tool-calls.js";
import type { ModelToolExecutionContext } from "../openpond/model-tool-registry.js";

export async function executeHostedProjectActionModelTool(input: {
  action: OpenPondActionCatalogEntry;
  context: ModelToolExecutionContext;
  implementation: Record<string, unknown>;
  actionInput: Record<string, unknown>;
  requestedProjectId?: string;
  resultToolName: string;
  executeProjectAction?: (payload: unknown) => Promise<unknown>;
}): Promise<NativeModelToolResult> {
  const { action, context, implementation, resultToolName } = input;
  if (!input.executeProjectAction) {
    return failedResult(context.callId, resultToolName, `Action ${action.id} is a hosted Project Action, but hosted action execution is not configured.`);
  }
  const projectId = stringValue(implementation.projectId);
  const teamId = stringValue(implementation.teamId);
  const releaseId = stringValue(implementation.releaseId);
  const projectActionId = stringValue(implementation.actionId) ?? action.id;
  if (!projectId || !teamId || !releaseId) {
    return failedResult(context.callId, resultToolName, `Action ${action.id} is missing its hosted Project Action release binding.`);
  }
  if (input.requestedProjectId && input.requestedProjectId !== projectId) {
    return failedResult(context.callId, resultToolName, `Project ${input.requestedProjectId} is not authorized for action ${action.id}.`);
  }
  const result = await input.executeProjectAction({
    action: projectActionId,
    input: input.actionInput,
    metadata: {
      source: "openpond_hosted_project_action",
      execution: "hosted",
      projectId,
      teamId,
      releaseId,
      selectedActionId: projectActionId,
      selectedActionLabel: action.label ?? action.name ?? projectActionId,
      selectedBy: "native_model_tool",
      displayPrompt: context.userPrompt,
      sessionId: context.session.id,
      turnId: context.turnId,
      toolCallId: context.callId,
    },
  });
  return {
    toolCallId: context.callId,
    name: resultToolName,
    ok: true,
    contentText: JSON.stringify({
      ok: true,
      action: resultToolName,
      output: `Ran hosted Project Action ${projectActionId}.`,
      data: { result },
    }, null, 2),
    data: { result },
  };
}

function failedResult(callId: string, name: string, error: string): NativeModelToolResult {
  return {
    toolCallId: callId,
    name,
    ok: false,
    contentText: JSON.stringify({ ok: false, action: name, error }, null, 2),
    data: { error },
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
