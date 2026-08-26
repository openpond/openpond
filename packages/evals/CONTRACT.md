# Portable contract map

`@openpond/harness` owns immutable Harness identities, workspaces,
model-driven refinement/review policy, improvements, traces, tools, model
identities, and shared hashing.
`@openpond/evals` owns Tasksets, graders, evaluation runs and receipts,
execution orchestration, conformance fixtures, Work-evidence eligibility, and
portable Run telemetry/metric semantics.
Evals depends on Harness for exact release identities but does not re-export
Harness APIs; Harness never depends on Evals. Host applications own persistence, provider sessions, secret
leases, connected-app authorization, model streaming, artifact bytes, and
runtime processes.

| Existing object | Portable object | Migration rule |
| --- | --- | --- |
| `Taskset` | `TasksetRelease` | Project only the released tasks, policy, environment, tools, capabilities, and graders. A Taskset is deliberately independent of any Harness so the same workload can run against local or hosted execution. Authoring state and UI readiness remain host state. |
| `HarnessRunManifest` (`openpond.harnessRunManifest.v1`) | `RunManifest` (`openpond.runManifest.v1`) | Treat the old object as a legacy training projection. Normalize its release/model/runtime identities into one new manifest; recipe, compute, engine, secret leases, and approval records remain host bindings referenced by hashes. |
| `HarnessRunTrace` | `HarnessTrace` | Preserve ordered actions, observations, lifecycle events, terminal state, failure class, and trace hash. Learning-signal envelopes remain a training projection of the trace and receipt. |
| `TaskAttemptResult` | `AttemptReceipt` | Preserve the old record for application persistence while adding a lossless receipt reference. Output becomes `outputHash`; trace and artifacts are separately hash-bound. |
| `GradeResult` | `GraderEvidence[]` | Preserve component score, pass, reward eligibility, failure class, feedback, and visible/private evidence references. Aggregate UI results remain host projections. |
| Human or model comparison of attempts | `PreferenceComparisonRelease` + `ComparisonAssignment` + `PreferenceReceipt` | Keep release policy, blinded candidate ordering, exact attempt/artifact references, reviewer identity, and ranking immutable. Human and model reviewers emit the same receipt; provider sessions, identity details, queue state, and artifact bytes remain host-owned. |
| Comparative reward | `PreferenceAggregationReceipt` + standard `RewardComponentReceipt` | Aggregate only with the release's named quorum algorithm, calibrate automated reviewers against non-frozen human receipts, then project the named pairwise-win fraction into the existing per-attempt reward component boundary. |
| managed-RL local receipt | `AttemptReceipt` | Submit canonical manifest/task/trace/artifact/grader identities; policy token responses and provider request IDs remain host-private trace data. |
| resolved training bundle | `HarnessRelease` + host training binding | Agent snapshot, program, lifecycle, tool declarations, files, and grader interface belong to the Harness. Taskset environment/policy/graders and dataset/evidence, recipe, compute, engine, approval, and opaque leases remain explicit host-side bindings. |
| completed Work or Development turn | `WorkEvidenceReceipt` | Project the authoritative terminal turn, immutable Agent snapshot when available, model/runtime identity, sanitized trace reference, exact output revisions, validation evidence, interventions, timing, usage, and explicit consent provenance. Keep the raw source and trace host-private. |
| Agent plus environment runtime events | `WorkProcessTrace` | Emit one ordered trace with `agent` and `environment` layers. Bind every environment step to its outer Agent tool call or stable Agent-turn receipt hash. Hash inputs/outputs and expose only enumerated, bounded attributes. |
| user feedback on Work output | `WorkFeedbackReceipt` | Append a new receipt bound to the evidence receipt and, when selected, the exact content-addressed output-revision descriptor. Corrections are separate artifacts and never mutate prior receipts. |
| bounded cross-Work review | `HarnessEvaluationReviewReceipt` | Select only currently authorized immutable evidence, advance one watermark, group one stable claim, route to the smallest correct layer, and name the next authority without performing downstream effects. |
| model-improvement qualification | `ModelImprovementQualificationReceipt` | Bind the originating review, exact Harness, Taskset, real baseline Evaluation, Model, Environment/tool/permission/policy hashes, Verifier, source policies, privacy, budget, and non-frozen signal. Weak or confounded evidence emits `no_training`; training and activation remain host effects. |
| trainer/runtime telemetry | `RunTelemetryEvent` + `MetricObservation` | Emit compact ordered events and observations with exact Run lineage, bounded attributes/dimensions, source authority, visibility, and stable idempotency identity. Tenant identity, provider credentials, storage, retention, billing, and durable indexes remain host projections. |
| local/hosted Run investigation export | `TelemetryExportBundle` | Export metric definitions, ordered evidence, bounded references, completeness, and a content hash. Apply visibility and redaction before crossing authority boundaries; never include raw privileged trace bytes. |

## Compatibility policy

- Schema versions are literal and independent from package semver.
- `openpond.harnessRunManifest.v1` and `openpond.taskAttempt.v1` remain accepted
  host persistence formats during migration, but are not emitted as new public
  identities by this package.
- Compatible package releases may add optional helpers and exports. Changing a
  required field, identity hash, or privacy boundary requires a new schema
  literal and an explicit normalizer.
- `openpond.agentSnapshot.v2`, `openpond.harnessRelease.v2`, and
  `openpond.tasksetRelease.v2` define the Harness-first boundary. The v2
  contracts remove the Profile reference from the Agent snapshot and keep the
  Taskset independent of a concrete Harness, environment, or policy binding.
- Runs with different Harness releases require an explicit
  `HarnessCompatibilityReceipt` binding both Harnesses to the same Taskset and
  recording environment, tool, policy, and grader-interface contract hashes.
  Callers with materialized releases should use
  `createVerifiedHarnessCompatibilityReceipt`; it derives those hashes from the
  immutable objects and rejects lifecycle, tool, grader-interface, or required
  Environment-tool drift before issuing the receipt.
- The initial support target is Node.js ESM on Node 22.14 through Node 24.
- Telemetry schema literals are shared across `@openpond/evals/telemetry` and
  the `openpond-evals` Python distribution. Generated JSON Schemas and positive
  and negative fixtures are the cross-language conformance authority.
- Telemetry producer sequence is monotonic within a Run. Receivers deduplicate
  exact retries, accept late delivery, and reject conflicting reuse of an
  idempotency key or `(runId, sequence)` pair.
- Core metrics reject unknown dimensions. Taskset- or Environment-specific
  extensions require an explicit `MetricDefinition`; arbitrary metric names or
  unbounded labels are not portable telemetry.
- Portable paths are relative and at most 2,000 characters. Individual assets
  are at most 250 MB. Tasksets, traces, and evidence arrays have schema-level
  upper bounds.
- Immutable content never contains secret values, opaque lease values, mutable
  provider resource IDs, database keys, UI state, or process handles.
- Preference comparisons are an additive group-evaluation protocol, not a new
  per-attempt grader kind and not a replacement for benchmark comparisons.
  Releases contain two through four candidates, an ordered-tie-group result
  policy, a frozen rubric artifact, presentation policy, aggregation policy,
  reward projection, and calibration thresholds. Assignments bind every visible
  artifact to an existing attempt and manifest under one Taskset, Harness,
  Environment, Verifier, tool, and policy lineage.
- A model preference receipt is reward-eligible only when a passed calibration
  report binds the exact comparison release and immutable model-reviewer
  release. Frozen-evaluation assignments cannot contribute calibration or
  training evidence. Invalid or unrenderable candidates remain unscorable;
  they are not silently converted into aesthetic losses.
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
