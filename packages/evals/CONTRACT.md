# Portable contract map

`@openpond/evals` owns the portable wire formats and pure protocol logic. Host
applications own persistence, provider sessions, secret leases, connected-app
authorization, model streaming, artifact bytes, and runtime processes.

| Existing object | Portable object | Migration rule |
| --- | --- | --- |
| `Taskset` | `TasksetRelease` | Project only the released tasks, policy, environment, tools, capabilities, graders, and immutable Harness binding. Authoring state and UI readiness remain host state. |
| `HarnessRunManifest` (`openpond.harnessRunManifest.v1`) | `RunManifest` (`openpond.runManifest.v1`) | Treat the old object as a legacy training projection. Normalize its release/model/runtime identities into one new manifest; recipe, compute, engine, secret leases, and approval records remain host bindings referenced by hashes. |
| `HarnessRunTrace` | `HarnessTrace` | Preserve ordered actions, observations, lifecycle events, terminal state, failure class, and trace hash. Learning-signal envelopes remain a training projection of the trace and receipt. |
| `TaskAttemptResult` | `AttemptReceipt` | Preserve the old record for application persistence while adding a lossless receipt reference. Output becomes `outputHash`; trace and artifacts are separately hash-bound. |
| `GradeResult` | `GraderEvidence[]` | Preserve component score, pass, reward eligibility, failure class, feedback, and visible/private evidence references. Aggregate UI results remain host projections. |
| managed-RL local receipt | `AttemptReceipt` | Submit canonical manifest/task/trace/artifact/grader identities; policy token responses and provider request IDs remain host-private trace data. |
| resolved training bundle | `HarnessRelease` + host training binding | Environment, tools, program, policy, files, and grader interface belong to the Harness. Dataset/evidence, recipe, compute, engine, approval, and opaque leases remain explicit host-side bindings. |

## Compatibility policy

- Schema versions are literal and independent from package semver.
- `openpond.harnessRunManifest.v1` and `openpond.taskAttempt.v1` remain accepted
  host persistence formats during migration, but are not emitted as new public
  identities by this package.
- Compatible package releases may add optional helpers and exports. Changing a
  required field, identity hash, or privacy boundary requires a new schema
  literal and an explicit normalizer.
- The initial support target is Node.js ESM on Node 22.14 through Node 24.
- Portable paths are relative and at most 2,000 characters. Individual assets
  are at most 250 MB. Tasksets, traces, and evidence arrays have schema-level
  upper bounds.
- Immutable content never contains secret values, opaque lease values, mutable
  provider resource IDs, database keys, UI state, or process handles.

## Runtime interfaces

`HarnessRuntime` owns create/reset/step/collect/destroy environment state.
`HarnessExecutor` owns the existing model or Agent loop and emits one receipt
plus a hash-bound trace. `EvaluationRunner` selects tasks, seeds, repetitions,
and models, invokes the executor, runs graders in their declared boundary, and
aggregates host results. Runtime adapters stay with Desktop or Sandbox.
