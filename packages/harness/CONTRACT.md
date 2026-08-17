# Harness package boundary

`@openpond/harness` owns portable, host-neutral Harness identities and state
transitions. Host applications own persistence, model streaming, provider
sessions, authorization, credential leases, local processes, and artifact
bytes.

## Dependency direction

`@openpond/evals` may depend on `@openpond/harness` but does not re-export it.
Applications import the packages directly so learning and evaluation authority
remain explicit. `@openpond/harness` must never import `@openpond/evals` or an
application package. This keeps Harness releases usable without installing an
evaluation runner.

## Compatibility

- Package semver and schema-version literals are independent.
- Immutable content never contains secrets, mutable database identifiers,
  provider handles, UI state, or process handles.
- Changing a required field or content-hash identity requires a new schema
  literal or an explicit normalizer.
- The initial support target is Node.js ESM on Node 22.14 through Node 24.
- Portable paths are at most 2,000 characters and individual portable assets
  are at most 250 MB.

## Runtime ownership

The package describes Agent snapshots, releases, workspaces, overlays,
improvement evidence, public provider-neutral Refiner and continuous-review
policy, bounded cross-Work review decisions, tools, model identities, and
traces. It also owns portable Refiner evidence bases, display-safe activity
receipts, bounded cross-run candidate state, candidate lifecycle receipts, and
continuation deduplication identity. Hosts provide authorized evidence and
model adapters. Models decide semantic grouping and smallest-layer routing;
deterministic package code owns schema, identity, bounds, and receipt
invariants.
Runtime Refiner requests and responses use their v2 schema literals. The
runtime decision must include an auditable evidence basis for every route or
proposal, may cite only IDs supplied in the bounded evidence packet, and may
propose only a capability advertised by the host. Invalid final decisions fail
closed to `no_action`; v1 remains a compatibility schema only.
Proposed mutations receive a second model critique for reusable root behavior
before deterministic validation. Large continuous-review windows use compact
model-driven navigation followed by full inspection of a bounded selection;
unselected evidence remains available to a later host watermark.
Evaluation execution and model-improvement qualification contracts that bind a
Harness to a Taskset, scored baseline, Model, verifier, and training signal
belong to `@openpond/evals`.
