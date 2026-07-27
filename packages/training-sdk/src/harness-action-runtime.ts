import {
  HarnessExecutionBundleManifestSchema,
  ModelActionSchema,
  ToolObservationSchema,
  type HarnessActionBinding,
  type HarnessExecutionBundleManifest,
  type ModelAction,
  type ToolObservation,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

export type StudentHarnessToolDefinition = {
  actionId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  sideEffect: HarnessActionBinding["sideEffect"];
};

export type HarnessActionExecutionResult = {
  output: Record<string, unknown>;
  artifactRefs?: string[];
  terminal?: boolean;
};

export type HarnessActionExecutor = (input: {
  binding: HarnessActionBinding;
  arguments: Record<string, unknown>;
  action: ModelAction;
  signal: AbortSignal;
}) => Promise<HarnessActionExecutionResult>;

/**
 * Builds the exact native tool catalog shown to the student from a materialized
 * student projection. Runtime IDs and capability receipts remain environment
 * metadata and are not exposed to the model.
 */
export function studentHarnessActionTools(
  manifestInput: HarnessExecutionBundleManifest,
): StudentHarnessToolDefinition[] {
  const manifest = verifiedManifest(manifestInput);
  if (manifest.target.projection !== "student") {
    throw new Error("Student tool definitions require a student Harness projection.");
  }
  return visibleBindings(manifest).map((binding) => ({
    actionId: binding.actionId,
    name: binding.modelToolName,
    description: binding.description,
    inputSchema: binding.inputSchema,
    sideEffect: binding.sideEffect,
  }));
}

/**
 * Dispatches one student tool call through the environment's pinned Agent
 * action resolver. The resolver is responsible for executing the immutable
 * Agent release named by the binding; this layer enforces projection, schema
 * hash, action integrity, and the per-action timeout.
 */
export async function executeHarnessActionBinding(input: {
  manifest: HarnessExecutionBundleManifest;
  action: ModelAction;
  execute: HarnessActionExecutor;
  episode?: {
    caseId: string;
  };
}): Promise<ToolObservation> {
  const manifest = verifiedManifest(input.manifest);
  if (
    manifest.target.projection !== "environment" &&
    manifest.target.projection !== "orchestrator" &&
    manifest.target.projection !== "trainer"
  ) {
    throw new Error(
      "Harness Agent actions can only execute from an environment, orchestrator, or trainer projection.",
    );
  }

  const action = ModelActionSchema.parse(input.action);
  const { contentHash: actionHash, ...actionContent } = action;
  if (contentHash(actionContent) !== actionHash) {
    throw new Error(`Harness action ${action.id} content hash is invalid.`);
  }
  if (action.kind !== "tool_call" || !action.name) {
    throw new Error("Harness Agent action dispatch requires a named tool_call.");
  }

  const bindings = visibleBindings(manifest);
  const binding = bindings.find(
    (candidate) => candidate.modelToolName === action.name,
  );
  if (!binding) {
    throw new Error(
      `Harness model tool ${action.name} is not bound in the student projection.`,
    );
  }
  if (contentHash(binding.inputSchema) !== binding.actionSchemaHash) {
    throw new Error(
      `Harness action ${binding.actionId} input schema does not match its pinned hash.`,
    );
  }
  const resolvedArguments = bindEpisodeArguments({
    binding,
    arguments: action.arguments,
    episode: input.episode,
  });

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      input.execute({
        binding,
        arguments: resolvedArguments,
        action,
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(
            `Harness action ${binding.actionId} exceeded ${binding.timeoutMs}ms.`,
          );
          controller.abort(error);
          reject(error);
        }, binding.timeoutMs);
      }),
    ]);
    const observationContent = {
      actionId: action.id,
      turn: action.turn,
      terminal: result.terminal ?? false,
      output: result.output,
      artifactRefs: result.artifactRefs ?? [],
    };
    return ToolObservationSchema.parse({
      ...observationContent,
      contentHash: contentHash(observationContent),
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function bindEpisodeArguments(input: {
  binding: HarnessActionBinding;
  arguments: Record<string, unknown>;
  episode?: { caseId: string };
}): Record<string, unknown> {
  const resolved = structuredClone(input.arguments);
  for (const binding of input.binding.episodeArgumentBindings) {
    if (Object.hasOwn(input.arguments, binding.argument)) {
      throw new Error(
        `Harness action ${input.binding.actionId} cannot accept caller-supplied episode argument ${binding.argument}.`,
      );
    }
    if (!input.episode?.caseId.trim()) {
      throw new Error(
        `Harness action ${input.binding.actionId} requires a privately bound episode case.`,
      );
    }
    resolved[binding.argument] = input.episode.caseId;
  }
  return resolved;
}

function verifiedManifest(
  input: HarnessExecutionBundleManifest,
): HarnessExecutionBundleManifest {
  const manifest = HarnessExecutionBundleManifestSchema.parse(input);
  const { contentHash: manifestHash, ...manifestContent } = manifest;
  if (contentHash(manifestContent) !== manifestHash) {
    throw new Error("Harness Execution Bundle manifest content hash is invalid.");
  }
  return manifest;
}

function visibleBindings(
  manifest: HarnessExecutionBundleManifest,
): HarnessActionBinding[] {
  const seenNames = new Set<string>();
  return (manifest.actionBindings ?? [])
    .filter((binding) => binding.studentVisible)
    .map((binding) => {
      if (seenNames.has(binding.modelToolName)) {
        throw new Error(
          `Harness model tool ${binding.modelToolName} is bound more than once.`,
        );
      }
      seenNames.add(binding.modelToolName);
      return binding;
    });
}
