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
| completed Work or Development turn | `WorkEvidenceReceipt` | Project the authoritative terminal turn, immutable Agent snapshot when available, model/runtime identity, sanitized trace reference, exact output revisions, validation evidence, interventions, timing, usage, and explicit consent provenance. Keep the raw source and trace host-private. |
| Agent plus environment runtime events | `WorkProcessTrace` | Emit one ordered trace with `agent` and `environment` layers. Bind every environment step to its outer Agent tool call or stable Agent-turn receipt hash. Hash inputs/outputs and expose only enumerated, bounded attributes. |
| user feedback on Work output | `WorkFeedbackReceipt` | Append a new receipt bound to the evidence receipt and, when selected, the exact content-addressed output-revision descriptor. Corrections are separate artifacts and never mutate prior receipts. |

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
- The Work evidence schemas first ship as additive `0.2.x` package exports. The
  package version does not replace the `openpond.workEvidenceReceipt.v1`,
  `openpond.workProcessTrace.v1`, `openpond.workFeedbackReceipt.v1`, or
  `openpond.workEvidenceEligibility.v1` schema literals.

## Work evidence boundary

- One `WorkEvidenceReceipt` spans the Agent and its environment or sandbox. A
  later Taskset/Harness replay emits one `AttemptReceipt`, not separate Agent and
  sandbox attempts.
- Portable traces contain no private-trace path or reference. Source identities
  are opaque SHA-256 URNs; artifacts and output-revision descriptors are
  content-addressed. Hidden reasoning, prompts, raw command arguments/output,
  local paths, credentials, provider handles, and raw validation text do not
  cross the portable boundary.
- Step attributes are closed and bounded: tool/validation/transition categories,
  intervention outcomes, artifact counts, exit status, duration, available CPU
  time and peak memory, and error class. Adding an arbitrary metadata bag would
  be a privacy-boundary change.
- Explicit process-and-artifact consent is required. Existing transcript consent
  is not upgraded implicitly. Workspace-owned or multi-participant evidence must
  satisfy the host's ownership and participant policy before projection.
- Receipts are immutable observations; current consent status is not. Revoked,
  expired, or source-deleted evidence is ineligible for all downstream uses.
  Hosts enforce source-bound deletion and distribution withdrawal outside the
  immutable receipt.
- An incomplete trace remains valid observational evidence but is blocked from
  eval, training, reward, and qualitative use according to the eligibility
  report. Reward candidacy additionally requires a verified and reward-eligible
  `AttemptReceipt` bound by hash.
- Feedback is append-only. `outputRevisionRef` identifies an exact revision
  descriptor even when two revisions contain identical bytes; correction
  content remains a separate private artifact unless a later policy explicitly
  permits disclosure.

## Runtime interfaces

`HarnessRuntime` owns create/reset/step/collect/destroy environment state.
`HarnessExecutor` owns the existing model or Agent loop and emits one receipt
plus a hash-bound trace. `EvaluationRunner` selects tasks, seeds, repetitions,
and models, invokes the executor, runs graders in their declared boundary, and
aggregates host results. Runtime adapters stay with Desktop or Sandbox.
