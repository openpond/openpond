# JavaScript tool environments

These entrypoints execute authored tool modules over owner-held JSON state:

- `@openpond/evals/javascript-environment` validates immutable definitions and creates an episode with `step`, `collect`, `snapshot` and `destroy`.
- `@openpond/evals/javascript-environment/node` executes each operation in a terminable worker around the isolated interpreter.
- `@openpond/evals/javascript-environment/attempt` runs a policy adapter through the declared tools and returns its messages, output and independently recorded state.

The interpreter exposes no host functions, filesystem, network, timers or module loader. Environment code receives an explicit seed and supplied inputs; ambient `Date` and `Math.random` are unavailable. A module cannot call a production connector or launch a process. Tools that require those capabilities need a separate host adapter and its permissions.

## Module contract

Publish the module as a `LearningTextAsset` with `host_private` visibility. Its exact asset reference belongs in a sealed `JavaScriptEnvironmentDefinition`. The definition lists each tool's schema, schema hash, side effect and timeout, plus episode step and byte limits.

The module exports five functions: `create`, `reset`, `step`, `collect` and `destroy`. Each receives one JSON object with `input`, `initialState`, `seed`, `state`, `sequence` and `action`. Every operation returns `{ state, observation }`, both JSON objects. `action` is null except during `step`, when it contains `{ name, arguments }`.

For example, a scoped record environment can implement:

```js
export function create({ initialState }) {
  return { state: initialState, observation: {} };
}
export const reset = create;
export function step({ input, state, action }) {
  if (action.name === "read_record") {
    return { state, observation: { record: state[action.arguments.id] ?? null } };
  }
  if (action.arguments.id !== input.allowedId) {
    return { state, observation: { error: "outside_scope" } };
  }
  return {
    state: { ...state, [action.arguments.id]: action.arguments.value },
    observation: { updated: true },
  };
}
export function collect({ state }) {
  return { state, observation: {} };
}
export function destroy() {
  return { state: {}, observation: {} };
}
```

Declare `read_record` as read-only and the update tool as a write. The owner verifies arguments before execution and rejects any state change from a read-only tool or collection. A failed operation leaves state unchanged. Invalid calls consume the step budget. The module can return an error observation for a simulated service failure while retaining an intentional transition, such as an idempotency record.

## Policy and evidence boundary

`runJavaScriptEnvironmentAttempt` supplies the policy adapter with copied messages and tool declarations. Initial state, module source and evaluator targets are not policy inputs. Initial and subsequent observations come from the module; the owner retains state and records every executed operation with its arguments, observation and before/after hashes.

A policy response contains `text` and `toolCalls`. Each call has a unique `id`, a declared `name` and JSON-object `arguments`. The loop executes calls sequentially, returns validation errors as tool observations and stops at the step, transcript or time limit. It collects state only after a final response with no tool calls. A model's claim about final state never replaces the recorded state.

Hosts persist the returned attempt under their task/model/release identity and grade the captured state with private checks. The attempt's content hash covers its task identity, status, output, state snapshot and messages. Completion of execution is not a passing grade, training qualification or promotion approval.

## Lifecycle ownership

Server hosts should pass `executeJavaScriptEnvironmentInWorker` as the session or attempt runner. Each worker runs a fresh interpreter. A promise settles only after the worker is terminated, including timeout and cancellation. The session rejects overlapping operations and waits for an active operation to stop before cleanup. Call `destroy` in `finally` when using the session API directly; the attempt runner does this automatically.

The policy adapter must honor its supplied abort signal and settle after cancelling its own request. `environmentCleanupComplete` describes environment cleanup only; it is not a provider billing or infrastructure-cleanup receipt. Failed creation, collection, cancellation and cleanup remain explicit states, without fabricated scores.
