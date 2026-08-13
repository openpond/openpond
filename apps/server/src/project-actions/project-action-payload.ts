import type { RuntimeEvent } from "@openpond/contracts";

import { event } from "../utils.js";
import { asRecord, stringValue } from "../api/server-payload-helpers.js";
import { runLocalProjectAction } from "./local-project-actions.js";

export function createProjectActionRunPayload(deps: {
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
  resolveProjectRoot: (projectId: string) => Promise<string | null>;
}) {
  return async function projectActionRunPayload(payload: unknown) {
    const input = asRecord(payload);
    const action = stringValue(input.action) ?? stringValue(input.actionName);
    if (!action) throw new Error("Project Action name is required.");
    const metadata = asRecord(input.metadata);
    const projectId = stringValue(metadata.projectId);
    if (!projectId) throw new Error("Project Action Project id is required.");
    const projectRoot = await deps.resolveProjectRoot(projectId);
    if (!projectRoot) throw new Error("Project Action Project is not registered locally.");
    const sessionId = stringValue(metadata.sessionId);
    const turnId = stringValue(metadata.turnId) ?? `openpond_project_action_${Date.now()}`;
    const toolCallId = stringValue(metadata.toolCallId);
    const result = await runLocalProjectAction({
      projectRoot,
      actionId: action,
      value: input.input ?? {},
      runId: toolCallId ?? undefined,
      idempotencyKey: toolCallId ? `${turnId}:${toolCallId}` : null,
    });
    if (sessionId) {
      await deps.appendRuntimeEvent(event({
        name: "workspace_action_result",
        sessionId,
        turnId,
        source: "chat_action",
        action: "project_action_run",
        appId: null,
        status: "completed",
        output: JSON.stringify(result.output),
        data: {
          openPondProjectActionRun: true,
          action: {
            name: action,
            label: stringValue(metadata.selectedActionLabel) ?? action,
          },
          runId: result.runId,
          traces: result.traces,
          outputs: result.outputs,
          outputDirectory: result.outputDirectory,
          durationMs: result.durationMs,
        },
      }));
    }
    return result;
  };
}
