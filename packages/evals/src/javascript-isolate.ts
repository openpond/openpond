import { newQuickJSWASMModuleFromVariant, Scope, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import { assertBoundedTaskJson } from "./task-schema.js";

export interface JavaScriptIsolateInput {
  source: string;
  exportName: string;
  value: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  maxResultBytes: number;
  deterministic?: boolean;
  errorPrefix: "verifier" | "environment" | "candidate";
}

export class JavaScriptIsolateExecutionError extends Error {
  constructor(message: string) { super(message); this.name = "JavaScriptIsolateExecutionError"; }
}

/** Authored code is interpreter data, with no host functions or module loader. */
export async function executeJavaScriptIsolate(input: JavaScriptIsolateInput): Promise<unknown> {
  validateJavaScriptIsolateInput(input);
  input.signal?.throwIfAborted();
  const error = (suffix: string) => new Error(`${input.errorPrefix}_${suffix}`);
  const deadline = Date.now() + input.timeoutMs;
  const module = await newQuickJSWASMModuleFromVariant(variant);
  input.signal?.throwIfAborted();
  try { return Scope.withScope((scope) => {
    const runtime = scope.manage(module.newRuntime());
    runtime.setMemoryLimit(33_554_432);
    runtime.setMaxStackSize(262_144);
    runtime.setInterruptHandler(() => Date.now() >= deadline || input.signal?.aborted === true);
    const context = scope.manage(runtime.newContext());
    if (input.deterministic) {
      scope.manage(context.unwrapResult(context.evalCode("globalThis.Date = undefined; Math.random = () => { throw new Error('environment_random_requires_explicit_seed'); };")));
    }
    const stringify = scope.manage(context.unwrapResult(context.evalCode("JSON.stringify")));
    const argument = scope.manage(context.unwrapResult(context.evalCode(`JSON.parse(${JSON.stringify(JSON.stringify(input.value))})`)));
    const exported = scope.manage(context.unwrapResult(context.evalCode(input.source, `${input.errorPrefix}.mjs`, { type: "module" })));
    const namespace = scope.manage(settle(context, exported, deadline, input.signal, error));
    const fn = scope.manage(context.getProp(namespace, input.exportName));
    if (context.typeof(fn) !== "function") throw error("function_export_missing");
    const returned = scope.manage(context.unwrapResult(context.callFunction(fn, context.undefined, argument)));
    const result = scope.manage(settle(context, returned, deadline, input.signal, error));
    const serialized = scope.manage(context.unwrapResult(context.callFunction(stringify, context.undefined, result)));
    if (context.typeof(serialized) !== "string") throw error("result_not_json");
    const json = context.getString(serialized);
    if (new TextEncoder().encode(json).byteLength > input.maxResultBytes) throw error("result_too_large");
    input.signal?.throwIfAborted();
    if (Date.now() >= deadline) throw error("timeout");
    const value: unknown = JSON.parse(json);
    assertBoundedTaskJson(value, input.maxResultBytes);
    return value;
  }); } catch (cause) {
    input.signal?.throwIfAborted();
    throw new JavaScriptIsolateExecutionError(cause instanceof Error ? cause.message : "JavaScript execution failed.");
  }
}

export function validateJavaScriptIsolateInput(input: JavaScriptIsolateInput): void {
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 300_000) throw new Error(`${input.errorPrefix}_timeout_invalid`);
  if (!Number.isInteger(input.maxResultBytes) || input.maxResultBytes < 1 || input.maxResultBytes > 4_194_304) throw new Error(`${input.errorPrefix}_result_limit_invalid`);
  if (new TextEncoder().encode(input.source).byteLength > 524_288) throw new Error(`${input.errorPrefix}_source_too_large`);
  assertBoundedTaskJson(input.value, 4_194_304);
}

function settle(context: QuickJSContext, handle: QuickJSHandle, deadline: number, signal: AbortSignal | undefined, error: (suffix: string) => Error): QuickJSHandle {
  for (;;) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw error("timeout");
    const state = context.getPromiseState(handle);
    if (state.type === "fulfilled") return state.notAPromise ? state.value.dup() : state.value;
    if (state.type === "rejected") return context.unwrapResult(state);
    const jobs = context.runtime.executePendingJobs(1);
    if (jobs.unwrap() === 0) throw error("unresolved_promise");
  }
}
