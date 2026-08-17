# `@openpond/harness`

Public provider-neutral learning operations, portable contracts, and pure
helpers for OpenPond's mutable Harness:

- immutable Agent snapshots and Harness releases;
- content-addressed assets, artifacts, releases, and hashes;
- tool declarations and model identities;
- Harness workspaces, pinned run overlays, proposals, validation, advancement,
  rollback, and merge receipts;
- improvement observations, Refiner outcomes, and apply receipts;
- versioned Refiner evidence-basis decisions and display-safe Work receipts;
- a public provider-neutral model-driven Refiner plus optional managed-host request/response contracts;
- model-driven continuous review over bounded authorized evidence, with exact
  source-policy, claim, routing, authority, and downstream lineage receipts;
- bounded cross-run candidates, lifecycle receipts, and continuation identities;
- model actions, tool observations, lifecycle events, and Harness traces.

```ts
import {
  HarnessReleaseSchema,
  HarnessEvaluationReviewReceiptSchema,
  HarnessRefinementCandidateSchema,
  HarnessRefinerActivityReceiptSchema,
  HarnessRunOverlaySchema,
  ImprovementObservationSchema,
  contentHash,
} from "@openpond/harness";
```

Subpath exports are available at `/harness`, `/evaluation-review`,
`/harness-improvements`, `/harness-workspaces`, `/refinement-lifecycle`,
`/models`, and `/tools`.

This package does not run evaluations, grade outputs, persist product state,
execute a desktop or hosted session, resolve credentials, schedule jobs, or
launch training. Hosts provide model streams and authorized evidence; the
package owns the shared Refiner and continuous-review policy. Evaluation
Tasksets, runners, receipts, graders, and Work-evidence eligibility live in
`@openpond/evals`, which depends on this package.

Semantic decisions are model-driven. Deterministic helpers enforce schema,
identity, bounds, safe targets, and receipt invariants; they do not assign a
route from prompt keywords, error strings, tool names, or a fixed recurrence
count.

The fast Refiner reviews one completed turn. Proposed edits receive a second
model critique before they can reach host validation, so task-specific content
can be generalized, routed, or rejected. Continuous review navigates large
authorized windows from compact previews, then inspects a bounded set of full
payloads. Evidence outside that full-review bound is deferred rather than
silently consumed. Neither operation launches training or activates a Model.

Runtime authoring uses `openpond.localHarnessRefinerDecision.v2`. Every route
or proposal names a `single_deterministic` or `recurrent_independent` evidence
basis, and the package rejects references that are not present in the bounded
packet. Proposal routes are also checked against the request's advertised
memory, prompt, Skill, and Agent capabilities. The v1 decision schema remains
exported for explicit compatibility reads; it is not the runtime authoring
contract.

## Verification

```bash
pnpm --dir packages/harness run check
```

The check typechecks, tests, builds, scans the public dependency boundary,
installs the packed tarball into a clean consumer, verifies runtime and
TypeScript imports, and dry-run packs the public artifact.
