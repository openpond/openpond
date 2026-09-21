import type { HarnessActionBinding, Taskset, Turn } from "@openpond/contracts";
import type { HostedToolInstructionMode } from "../../openpond/hosted-tool-protocol.js";

export function workspaceToolCorrectionMessage(
    textFallbackMode: HostedToolInstructionMode,
    nativeToolsAvailable: boolean
  ): string {
    const toolCallInstruction = nativeToolsAvailable
      ? "Call an appropriate native tool now."
      : textFallbackMode === "resource_text_fallback"
      ? "Call a resource_search or resource_read openpond_tool block now."
      : textFallbackMode === "full_text_fallback"
      ? "Call the appropriate openpond_tool block now."
      : "Explain the blocker instead of claiming the workspace changed.";
    return [
      "Your previous response did not call a workspace tool.",
      "The user's request appears to require inspecting or changing the active workspace.",
      toolCallInstruction,
      "Do not claim the workspace changed until a tool result confirms it.",
      "If the request cannot be completed with the available workspace tools, explain the blocker instead of saying it is done.",
    ].join(" ");
  }

export async function trainingHarnessForTurn(
    turn: Turn,
    getTaskset: ((tasksetId: string) => Promise<Taskset | null>) | undefined
  ): Promise<
    | {
        taskId: string;
        actionBindings: HarnessActionBinding[];
      }
    | undefined
  > {
    const tasksetId =
      typeof turn.metadata.trainingTasksetId === "string"
        ? turn.metadata.trainingTasksetId.trim()
        : "";
    const taskId =
      typeof turn.metadata.trainingHarnessTaskId === "string"
        ? turn.metadata.trainingHarnessTaskId.trim()
        : "";
    if (!tasksetId || !taskId || !getTaskset) return undefined;
    const taskset = await getTaskset(tasksetId);
    if (!taskset || taskset.environment.kind !== "stateful_harness") {
      return undefined;
    }
    const task = taskset.tasks.find((candidate) => {
      const caseId =
        typeof candidate.metadata.caseId === "string"
          ? candidate.metadata.caseId.trim()
          : "";
      return candidate.id === taskId || caseId === taskId;
    });
    if (!task) return undefined;
    const actionBindings = taskset.environment.actionBindings ?? [];
    return actionBindings.length ? { taskId, actionBindings } : undefined;
  }
