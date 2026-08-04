# `@openpond/evals`

Portable OpenPond contracts and reference helpers for immutable Agent snapshots,
Harness releases, Taskset releases, run manifests, attempt receipts, deterministic
graders, and conformance fixtures.

```ts
import {
  AttemptReceiptSchema,
  HarnessReleaseSchema,
  TasksetReleaseSchema,
  validateTasksetRelease,
  verifyAttemptReceipt,
} from "@openpond/evals";
```

Subpath exports are available at `/harness`, `/tasksets`, `/graders`, `/runs`,
and `/conformance`. The package is a protocol library, not a hosted client. It
does not execute OpenPond Desktop or Sandbox sessions, resolve credentials, or
persist artifacts.

## Privacy boundary

Release content may include approved policy-visible assets and immutable hashes
for verifier/host-private assets. Never serialize secrets, credential leases,
provider resource handles, database identifiers, unrelated conversations, or
mutable local UI state. Private graders receive only their declared evidence and
must execute outside the policy-controlled Agent environment when tamper
resistance matters.

## Runtime adapters

Implement `HarnessRuntime` for environment state and `HarnessExecutor` around
the host's existing model/Agent loop. Do not reimplement prompting, tool dispatch,
session persistence, cost accounting, cancellation, or cleanup in this package.
A Prime-style environment maps reset/step/observation semantics to the same
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

The first npm publication must be bootstrapped manually before trusted publishing
can take over. Publication uses package-specific `evals-vX.Y.Z` tags and npm
provenance; see the release workflow for the exact one-time setup.
