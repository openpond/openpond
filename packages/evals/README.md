# `@openpond/evals`

Portable evaluation contracts and pure helpers for Tasksets, graders, run
manifests, attempt and evaluation receipts, execution adapters, conformance
fixtures, Work-evidence eligibility, and no-training/SFT/preference/RL
qualification receipts. The package depends on
[`@openpond/harness`](../harness/README.md) for exact Harness identities but
does not re-export Harness APIs. Applications import the two packages directly,
which keeps refinement and evaluation authority visibly separate.

```ts
import {
  AttemptReceiptSchema,
  TasksetReleaseSchema,
  ModelImprovementQualificationReceiptSchema,
  validateTasksetRelease,
  verifyAttemptReceipt,
} from "@openpond/evals";

import { HarnessReleaseSchema } from "@openpond/harness";

import {
  WorkEvidenceReceiptSchema,
  classifyWorkEvidence,
  workEvidenceConformance,
} from "@openpond/evals/evidence";
```

Subpath exports are available at `/harness`, `/tasksets`, `/graders`, `/runs`,
`/conformance`, `/evidence`, `/review`, and
`/model-improvement-qualification`. The package is an evaluation protocol library,
not a hosted client. It does not execute OpenPond Desktop or Sandbox sessions,
resolve credentials, or persist artifacts.

## Harness Evaluation review

`@openpond/harness` owns the public model-driven Refiner and continuous-review
policy plus immutable bounded decisions and receipts. Evals does not own
learning prompts, evidence selection, scheduling, or Harness mutation. It
binds an accepted review to the exact Harness, Taskset, scored
baseline Evaluation, base Model, Environment/tool/permission/policy hashes,
Verifier, source-policy checks, privacy approval, budget approval, and eligible
non-frozen learning signal. Frozen Evaluation evidence is rejected as training
evidence. Weak, constant, confounded, uncalibrated, revoked, or incompletely
authorized signal produces `no_training`; it cannot qualify a managed run.

## Work evidence

`WorkEvidenceReceipt` records one completed Work or Development turn as a single
observational evidence unit. Its sanitized `WorkProcessTrace` combines Agent
actions with environment or sandbox actions. Every environment step is bound to
the outer Agent tool-call receipt hash or, for automatic lifecycle work, the
stable Agent-turn receipt hash. Commands, exit status, lifecycle transitions,
output and validation references, timing, and available CPU or peak-memory
observations stay in that one trace.

This receipt is not an evaluation result. A Taskset/Harness replay still emits
exactly one `AttemptReceipt`; callers may classify Work evidence as an eval,
training, reward, or qualitative candidate only through the explicit eligibility
report. Reward candidacy requires a verified, reward-eligible Attempt receipt.

Feedback is append-only and can bind an exact content-addressed output revision.
Corrections remain separate artifacts and are valid only for
`needs_correction` feedback.

## Privacy boundary

Release content may include approved policy-visible assets and immutable hashes
for verifier/host-private assets. Never serialize secrets, credential leases,
provider resource handles, database identifiers, unrelated conversations, or
mutable local UI state. Private graders receive only their declared evidence and
must execute outside the policy-controlled Agent environment when tamper
resistance matters.

Work evidence requires explicit `work_process_and_artifacts` consent; transcript
consent is not sufficient. Portable receipts expose only opaque source/workspace
URNs, content hashes, bounded enums and counters, and sanitized artifact
references. Raw traces and correction bytes stay host-private. Consent,
revocation, expiry, deletion, ownership, participant policy, and source-bound
retention remain authoritative host policy state; an immutable receipt never
overrides that state.

## Runtime adapters

Implement `HarnessRuntime` for environment state and `HarnessExecutor` around
the host's existing model/Agent loop. Do not reimplement prompting, tool dispatch,
session persistence, cost accounting, cancellation, or cleanup in this package.
A step-based environment maps reset/step/observation semantics to the same
interfaces and keeps provider allocation, authentication, and cleanup in its host.

## Conformance

Run both `genericToolConformance` and `marketingPortfolioConformance` through the
same adapter. The marketing fixture is named test data, not a runtime switch.
Compare manifest, terminal/failure, output, trace, artifact, and grader receipt
semantics. Infrastructure failures must remain reward-ineligible.

## Schema lifecycle

Package semver and schema literals are independent. See [CONTRACT.md](./CONTRACT.md)
for compatibility aliases, migration rules, size limits, and the field map.

## Release preparation

```bash
pnpm --dir packages/evals run check
pnpm run release:evals:patch -- --dry-run
```

Publication uses package-specific `evals-vX.Y.Z` tags, npm trusted publishing,
and provenance. See the release workflow for release preparation and verification.
