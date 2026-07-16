import { describe, expect, test } from "vitest";
import {
  createTurnRunner,
  hostedToolInstructionModeForProvider,
  nativeToolTransportEnabledForProvider,
  normalizeMentionedSandboxToolRequest,
  resolveConnectedAppContextsForTurn,
  resolveHostedToolRolloutFlags,
  type HostedToolMode,
  type HostedToolRolloutFlags,
} from "../apps/server/src/runtime/turn-runner";

type PublicRunner = ReturnType<typeof createTurnRunner>;
type ExpectedRunner = {
  sendTurn: PublicRunner["sendTurn"];
  isSessionTurnActive: PublicRunner["isSessionTurnActive"];
  interruptSessionTurn: PublicRunner["interruptSessionTurn"];
  interruptAll: PublicRunner["interruptAll"];
  close: PublicRunner["close"];
  updateTurnCreatePipeline: PublicRunner["updateTurnCreatePipeline"];
  resolveCreatePipelineApproval: PublicRunner["resolveCreatePipelineApproval"];
  resolveSubagentPatchApplyApproval: PublicRunner["resolveSubagentPatchApplyApproval"];
  runSubagentLifecycleAction: PublicRunner["runSubagentLifecycleAction"];
  cleanupExpiredRetainedSubagentWorkspace: PublicRunner["cleanupExpiredRetainedSubagentWorkspace"];
};

const compileOnlyPublicSurface: {
  createTurnRunner: typeof createTurnRunner;
  resolveHostedToolRolloutFlags: typeof resolveHostedToolRolloutFlags;
  nativeToolTransportEnabledForProvider: typeof nativeToolTransportEnabledForProvider;
  hostedToolInstructionModeForProvider: typeof hostedToolInstructionModeForProvider;
  resolveConnectedAppContextsForTurn: typeof resolveConnectedAppContextsForTurn;
  normalizeMentionedSandboxToolRequest: typeof normalizeMentionedSandboxToolRequest;
} = {
  createTurnRunner,
  resolveHostedToolRolloutFlags,
  nativeToolTransportEnabledForProvider,
  hostedToolInstructionModeForProvider,
  resolveConnectedAppContextsForTurn,
  normalizeMentionedSandboxToolRequest,
};

function acceptsFrozenRunnerSurface(runner: PublicRunner): ExpectedRunner {
  return runner;
}

describe("turn-runner public contract", () => {
  test("keeps the frozen exports and lifecycle-aware runner shape importable", () => {
    const mode: HostedToolMode = "auto";
    const flags: HostedToolRolloutFlags = resolveHostedToolRolloutFlags({ toolMode: mode });
    expect(Object.keys(compileOnlyPublicSurface).sort()).toEqual([
      "createTurnRunner",
      "hostedToolInstructionModeForProvider",
      "nativeToolTransportEnabledForProvider",
      "normalizeMentionedSandboxToolRequest",
      "resolveConnectedAppContextsForTurn",
      "resolveHostedToolRolloutFlags",
    ]);
    expect(flags.toolMode).toBe("auto");
    expect(typeof acceptsFrozenRunnerSurface).toBe("function");
  });
});
