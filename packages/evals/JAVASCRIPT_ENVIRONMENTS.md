# JavaScript tool environments

These entrypoints execute authored tool modules over owner-held JSON state:

- `@openpond/evals/javascript-environment` validates immutable definitions and creates an episode with `step`, `collect`, `snapshot` and `destroy`.
- `@openpond/evals/javascript-environment/node` exposes worker and Node subprocess owners around the isolated interpreter.
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

Server hosts that require process isolation should pass `executeJavaScriptEnvironmentInProcess` as the session or attempt runner. It requires Node 22.14–24 on `PATH` and gives each operation a fresh Node child and QuickJS interpreter. The child inherits only `PATH`, uses a bounded heap and response stream, and is killed on timeout or cancellation. Authored source travels as JSON interpreter data. A promise settles only after the child exits. This keeps interpreter allocation outside the execution owner's worker-thread lifecycle. `executeJavaScriptVerifierInProcess` provides the same ownership for graders from `@openpond/evals/javascript-verifier/node`.

Node hosts can also use `executeJavaScriptEnvironmentInWorker`. Each worker runs a fresh interpreter and settles only after termination. Both owners include startup in the declared deadline; neither retries failed operations. The session rejects overlapping operations and waits for active execution to stop before cleanup. Call `destroy` in `finally` when using the session API directly; the attempt runner does this automatically.

Cleanup receives the definition's `operationTimeoutMs`, including interpreter and
worker startup, with no shorter implicit deadline. It still runs after the episode
is cancelled, waits for worker termination, and fails explicitly when that bounded
operation deadline is exceeded.

The policy adapter must honor its supplied abort signal and settle after cancelling its own request. `environmentCleanupComplete` describes environment cleanup only; it is not a provider billing or infrastructure-cleanup receipt. Failed creation, collection, cancellation and cleanup remain explicit states, without fabricated scores.

## Submitted SQL and JavaScript

An optional `executionServices` array on the immutable environment definition binds
an owner-controlled service to a named `step` tool or to `collect`. Omission preserves
existing definition hashes. Each service declares an identity, deadline and explicit
value references: `{ scope: "input" | "initialState" | "state" | "arguments", path: [...] }`.
References traverse own JSON properties only. The controller receives service results
as `services[id]`; candidates cannot supply that field.

A `sqlite.v1` binding declares `sql`, `snapshot`, `maxRows` and `maxResultBytes`.
Snapshots contain named tables, typed columns (`INTEGER`, `REAL`, `TEXT`, `BLOB`) and
array rows. SQLite executes exactly one statement in a fresh in-memory database.
The Node adapter enforces read-only authorization, a deterministic function allowlist,
a 32 MiB WASM memory maximum, value/SQL/result limits and a parent-owned deadline.
Writes, attachment, pragma changes, extensions and nondeterministic functions are
rejected. Results retain ordered column names and array rows, including duplicates.
SQL null is JSON null; exact large integers use `{ integer: "9223372036854775807" }`
and blobs use `{ blobBase64: "AP8=" }`. JSON numbers retain their ordinary IEEE-754
semantics. Use tagged integers when exact 64-bit storage is required.

A `javascript.v1` binding declares `source`, `cases`, `exportName`, `maxCases` and
`maxResultBytes`. Cases are owner-held objects with an `input` property. Each case
runs in a fresh QuickJS interpreter, and only its `input` crosses into the candidate.
Other properties, including expected results, remain with the owner. Put hidden cases
and expectations in private `initialState`, not task `input`: task input is part of
the policy transcript. The authored controller grades returned case values against
its own expectations. No host functions, module loader, filesystem or network are
exposed to candidate JavaScript.

Service outcomes are either completed results or explicit rejected submissions.
Syntax, authorization, output and engine-memory failures cannot manufacture a passing
answer. A service timeout produces a rejected outcome only after child termination;
owner cancellation and infrastructure setup failures still fail the operation.
Service preparation and the authored controller share the operation's overall budget
and its tracked promise. Collection remains unable to mutate session state, and
`destroy()` aborts and awaits all active work before running authored cleanup.

`executeJavaScriptEnvironmentInProcess` and `executeJavaScriptEnvironmentInWorker`
provide these services on Node hosts; service children always use Node processes.
The portable in-process interpreter supports candidate JavaScript and rejects a SQL
binding without a Node SQL executor. The standalone Node API is
`executeSqlInProcess({ request, timeoutMs, signal })` from
`@openpond/evals/sql-execution/node`; request/result schemas are available from
`@openpond/evals/sql-execution`. The SQLite WASM bytes are embedded in the trusted
child program, so execution survives installation and host bundling without resolving
an application-relative WASM file or loading submitted code as host JavaScript.
