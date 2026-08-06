# `@openpond/harness`

Portable contracts and pure helpers for OpenPond's mutable Harness:

- immutable Agent snapshots and Harness releases;
- content-addressed assets, artifacts, releases, and hashes;
- tool declarations and model identities;
- Harness workspaces, pinned run overlays, proposals, validation, advancement,
  rollback, and merge receipts;
- improvement observations, Refiner outcomes, and apply receipts;
- model actions, tool observations, lifecycle events, and Harness traces.

```ts
import {
  HarnessReleaseSchema,
  HarnessRunOverlaySchema,
  ImprovementObservationSchema,
  contentHash,
} from "@openpond/harness";
```

Subpath exports are available at `/harness`, `/harness-improvements`,
`/harness-workspaces`, `/models`, and `/tools`.

This package does not run evaluations, grade outputs, persist product state,
execute a desktop or hosted session, or resolve credentials. Evaluation
Tasksets, runners, receipts, graders, and Work-evidence eligibility live in
`@openpond/evals`, which depends on this package.

## Verification

```bash
pnpm --dir packages/harness run check
```

The check typechecks, tests, builds, scans the public dependency boundary,
installs the packed tarball into a clean consumer, verifies runtime and
TypeScript imports, and dry-run packs the public artifact.
