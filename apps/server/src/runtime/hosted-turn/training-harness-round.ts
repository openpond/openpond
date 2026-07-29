import type { HarnessActionBinding } from "@openpond/contracts";
import type { HostedChatTool, HostedChatToolChoice } from "@openpond/cloud";

export function hostedTrainingHarnessRound(input: {
  trainingHarness:
    | {
        actionBindings: HarnessActionBinding[];
      }
    | null
    | undefined;
  completedActionCount: number;
  nativeTools: HostedChatTool[];
}): {
  tools: HostedChatTool[];
  toolChoice: HostedChatToolChoice;
  requiredToolName: string | null;
} | null {
  if (!input.trainingHarness) return null;
  const requiredToolName =
    input.trainingHarness.actionBindings[input.completedActionCount]
      ?.modelToolName ?? null;
  if (!requiredToolName) {
    return {
      tools: [],
      toolChoice: "none",
      requiredToolName: null,
    };
  }
  const requiredToolIndex = input.nativeTools.findIndex(
    (tool) => tool.function?.name === requiredToolName
  );
  if (requiredToolIndex < 0) {
    throw new Error(
      `Training harness tool ${requiredToolName} is unavailable to the hosted model.`
    );
  }
  return {
    tools: input.nativeTools.slice(0, requiredToolIndex + 1),
    toolChoice: "required",
    requiredToolName,
  };
}
