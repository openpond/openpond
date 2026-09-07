import { contentHash } from "@openpond/harness";
import { verifyLearningTextAsset, type LearningTextAsset } from "./learning/assets.js";
import { assertBoundedTaskJson, validateTaskValue } from "./task-schema.js";
import { executeJavaScriptIsolate } from "./javascript-isolate.js";
import { assertJavaScriptEnvironmentDefinition, JavaScriptEnvironmentOperationSchema, JavaScriptEnvironmentResultSchema, type JavaScriptEnvironmentDefinition, type JavaScriptEnvironmentOperation, type JavaScriptEnvironmentResult } from "./javascript-environment-contract.js";
export * from "./javascript-environment-contract.js";

export interface JavaScriptEnvironmentExecutionInput {
  source: string;
  operation: JavaScriptEnvironmentOperation;
  value: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Pure, bounded module execution. Server hosts should provide the worker runner. */
export async function executeJavaScriptEnvironment(input: JavaScriptEnvironmentExecutionInput): Promise<JavaScriptEnvironmentResult> {
  const operation = JavaScriptEnvironmentOperationSchema.parse(input.operation);
  return JavaScriptEnvironmentResultSchema.parse(await executeJavaScriptIsolate({ ...input, exportName: operation, maxResultBytes: 1_572_864, deterministic: true, errorPrefix: "environment" }));
}

export interface JavaScriptEnvironmentEvent {
  sequence: number;
  operation: JavaScriptEnvironmentOperation;
  toolName: string | null;
  arguments: Record<string, unknown> | null;
  observation: Record<string, unknown> | null;
  beforeStateHash: string;
  afterStateHash: string;
  error: string | null;
}

export interface JavaScriptEnvironmentSnapshot {
  definition: { id: string; revision: number; contentHash: string };
  inputHash: string;
  seed: number;
  initialStateHash: string;
  finalStateHash: string;
  state: Record<string, unknown>;
  events: JavaScriptEnvironmentEvent[];
}

export class JavaScriptEnvironmentActionError extends Error {
  constructor(readonly code: "unknown_tool" | "invalid_arguments" | "step_budget_exhausted") {
    super(`environment_${code}`);
    this.name = "JavaScriptEnvironmentActionError";
  }
}

type Runner = (input: JavaScriptEnvironmentExecutionInput) => Promise<JavaScriptEnvironmentResult>;

/** One episode, with owner-held state that is never accepted from model output.
 * Read-only tools and collection cannot change it. Call destroy in a finally block. */
export async function createJavaScriptEnvironmentSession(input: {
  definition: JavaScriptEnvironmentDefinition;
  asset: LearningTextAsset;
  input: Record<string, unknown>;
  initialState: Record<string, unknown>;
  seed: number;
  execute?: Runner;
  signal?: AbortSignal;
}) {
  const definition = assertJavaScriptEnvironmentDefinition(input.definition);
  const source = verifyLearningTextAsset(input.asset, definition.module);
  if (!Number.isSafeInteger(input.seed)) throw new Error("environment_seed_invalid");
  const seed = input.seed;
  assertBoundedTaskJson(input.input, 1_048_576);
  assertBoundedTaskJson(input.initialState, definition.maxStateBytes);
  const taskInput = structuredClone(input.input), initialState = structuredClone(input.initialState);
  const execute = input.execute ?? executeJavaScriptEnvironment;
  const controller = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  let state: Record<string, unknown> = {};
  let steps = 0, closed = false, closing = false;
  let active: Promise<JavaScriptEnvironmentResult> | null = null;
  const events: JavaScriptEnvironmentEvent[] = [];
  let closePromise: Promise<void> | null = null;

  async function invoke(operation: JavaScriptEnvironmentOperation, action?: { name: string; arguments: Record<string, unknown> }) {
    if (closed || closing) throw new Error("environment_closed");
    if (active) throw new Error("environment_operation_in_progress");
    signal.throwIfAborted();
    if (action) { assertBoundedTaskJson(action, 262_144); action = structuredClone(action); }
    const beforeStateHash = contentHash(state);
    const tool = action ? definition.tools.find(tool => tool.name === action.name) : null;
    if (operation === "step") {
      if (steps >= definition.maxSteps) throw new JavaScriptEnvironmentActionError("step_budget_exhausted");
      steps++;
    }
    const record = (observation: Record<string, unknown> | null, error: string | null) => events.push({ sequence: events.length, operation, toolName: action?.name ?? null, arguments: action ? structuredClone(action.arguments) : null, observation, beforeStateHash, afterStateHash: contentHash(state), error });
    try {
      if (action && !tool) throw new JavaScriptEnvironmentActionError("unknown_tool");
      if (action && tool && !validateTaskValue(tool.inputSchema, action.arguments).valid) throw new JavaScriptEnvironmentActionError("invalid_arguments");
      const promise = execute({ source, operation, value: { input: taskInput, initialState, seed, state: structuredClone(state), sequence: steps, action: action ? structuredClone(action) : null }, timeoutMs: Math.min(definition.operationTimeoutMs, tool?.timeoutMs ?? definition.operationTimeoutMs), signal });
      active = promise;
      const result = JavaScriptEnvironmentResultSchema.parse(await promise);
      signal.throwIfAborted();
      assertBoundedTaskJson(result.state, definition.maxStateBytes);
      assertBoundedTaskJson(result.observation, definition.maxObservationBytes);
      if ((operation === "collect" || tool?.sideEffect === "read") && contentHash(result.state) !== beforeStateHash) throw new Error("environment_read_changed_state");
      state = structuredClone(result.state);
      const observation = structuredClone(result.observation);
      record(observation, null);
      return { state: structuredClone(state), observation };
    } catch (error) {
      record(null, error instanceof Error ? error.message : "environment_execution_failed");
      throw error;
    } finally { active = null; }
  }

  async function destroy(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    controller.abort(new Error("environment_destroyed"));
    closePromise = (async () => {
      try {
        // A worker runner settles only after termination; cleanup cannot race it.
        try { await active; } catch { /* The operation failure is retained by its caller. */ }
        // Cleanup owns the declared operation budget, including worker startup.
        // A shorter implicit cap can invalidate an otherwise collected attempt.
        await execute({ source, operation: "destroy", value: { input: taskInput, initialState, seed, state: structuredClone(state), sequence: steps, action: null }, timeoutMs: definition.operationTimeoutMs });
      } finally { state = {}; closed = true; }
    })();
    return closePromise;
  }

  try {
    await invoke("create");
    const reset = await invoke("reset");
    const initialStateHash = contentHash(state);
    const snapshot = (): JavaScriptEnvironmentSnapshot => {
      if (closed) throw new Error("environment_closed");
      return { definition: { id: definition.id, revision: definition.revision, contentHash: definition.contentHash }, inputHash: contentHash(taskInput), seed, initialStateHash, finalStateHash: contentHash(state), state: structuredClone(state), events: structuredClone(events) };
    };
    return {
      definition: structuredClone(definition),
      observation: reset.observation,
      async step(action: { name: string; arguments: Record<string, unknown> }) { return (await invoke("step", action)).observation; },
      async collect() {
        const result = await invoke("collect");
        return { ...snapshot(), observation: result.observation };
      },
      snapshot,
      destroy,
    };
  } catch (error) {
    try { await destroy(); } catch { /* Preserve the original creation failure after owner cleanup. */ }
    throw error;
  }
}
