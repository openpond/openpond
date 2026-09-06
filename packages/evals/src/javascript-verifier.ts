import { newQuickJSWASMModuleFromVariant, Scope, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import { assertBoundedTaskJson } from "./task-schema.js";
import { JavaScriptVerifierResultSchema, type JavaScriptVerifierResult } from "./javascript-verifier-contract.js";
export { JavaScriptVerifierResultSchema, type JavaScriptVerifierResult } from "./javascript-verifier-contract.js";

/**
 * A fresh WebAssembly interpreter with no host functions, filesystem, network,
 * timers, or module loader. Hosts should run this on a worker to remain responsive
 * and terminate that worker when cancellation is requested.
 */
export async function executeJavaScriptVerifier(input: {
  source: string;
  exportName?: string;
  value: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<JavaScriptVerifierResult> {
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 300_000) throw new Error("verifier_timeout_invalid");
  if (new TextEncoder().encode(input.source).byteLength > 524_288) throw new Error("verifier_source_too_large");
  assertBoundedTaskJson(input.value, 4_194_304);
  input.signal?.throwIfAborted();
  const deadline = Date.now() + input.timeoutMs;
  const module = await newQuickJSWASMModuleFromVariant(variant);
  input.signal?.throwIfAborted();
  return Scope.withScope((scope) => {
    const runtime = scope.manage(module.newRuntime());
    runtime.setMemoryLimit(33_554_432);
    runtime.setMaxStackSize(262_144);
    runtime.setInterruptHandler(() => Date.now() >= deadline || input.signal?.aborted === true);
    const context = scope.manage(runtime.newContext());
    const stringify = scope.manage(context.unwrapResult(context.evalCode("JSON.stringify")));
    const argument = scope.manage(context.unwrapResult(context.evalCode(`JSON.parse(${JSON.stringify(JSON.stringify(input.value))})`)));
    const exported = scope.manage(context.unwrapResult(context.evalCode(input.source, "verifier.mjs", { type: "module" })));
    const namespace = scope.manage(settle(context, exported, deadline, input.signal));
    const fn = scope.manage(context.getProp(namespace, input.exportName ?? "verify"));
    if (context.typeof(fn) !== "function") throw new Error("verifier_function_export_missing");
    const returned = scope.manage(context.unwrapResult(context.callFunction(fn, context.undefined, argument)));
    const result = scope.manage(settle(context, returned, deadline, input.signal));
    const serialized = scope.manage(context.unwrapResult(context.callFunction(stringify, context.undefined, result)));
    if (context.typeof(serialized) !== "string") throw new Error("verifier_result_not_json");
    const json = context.getString(serialized);
    if (new TextEncoder().encode(json).byteLength > 65_536) throw new Error("verifier_result_too_large");
    input.signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error("verifier_timeout");
    const value: unknown = JSON.parse(json);
    assertBoundedTaskJson(value, 65_536);
    return JavaScriptVerifierResultSchema.parse(value);
  });
}

function settle(context: QuickJSContext, handle: QuickJSHandle, deadline: number, signal?: AbortSignal): QuickJSHandle {
  for (;;) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error("verifier_timeout");
    const state = context.getPromiseState(handle);
    if (state.type === "fulfilled") return state.notAPromise ? state.value.dup() : state.value;
    if (state.type === "rejected") return context.unwrapResult(state);
    const jobs = context.runtime.executePendingJobs(1);
    if (jobs.unwrap() === 0) throw new Error("verifier_unresolved_promise");
  }
}
