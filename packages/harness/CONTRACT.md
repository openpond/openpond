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
continuation deduplication identity. Review Profiles, Refiner releases,
bindings, and transition receipts are portable contracts, but their storage,
selection, activation policy, and rollback execution remain host-owned. A
Harness release and a Refiner release are adjacent identities: neither embeds
or mutates the other, and a review receipt pins both. Hosts provide authorized evidence and
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

## Released source transport

`openpond.harnessSourcePackage.v1` carries the complete immutable Agent
snapshot, Harness release and their released file bytes. Creation and readback
verify both release hashes, dependency references, the exact file population,
canonical base64, individual file hashes and a 25 MiB total byte limit.
Rehashing a transport envelope does not authorize different source bytes.
Instruction and Skill entry files must be policy-visible; verifier and
host-private assets retain their declared visibility and must never be exposed
to a policy by iterating the complete source map.

This is source transport, not runtime conformance. Hosts authorize export and
select an execution adapter that consumes the captured source, verifies its
capabilities and records effective context. A matching Harness release hash
alone does not prove that instructions, Skills or executable dependencies ran.

`createHarnessSourceRuntime` consumes captured source for the declarative
`openpond.agent-runtime.v1` program. It loads released instruction and Skill
text, verifies required capabilities, dependency versions and actual tool
schemas, and exposes policy-visible resources through bounded byte-range reads.
Private assets never enter its context or reader. Unsupported programs and
released subagents fail admission. Hosts must provide their actual tools and
capabilities; this helper does not implement missing execution capabilities.
The runtime receipt binds the source, effective system prompt, loaded assets
and tool definitions. Hosts retain that receipt with attempt evidence.

`executeHarnessRollout` owns the shared policy/environment round lifecycle,
released resource calls, retained conversation and exhaustion behavior. Hosts
supply policy transport and environment step/termination operations. Desktop's
agent runtime re-exports the same provider loop from this package.
`@openpond/harness/runtime-source` distributes a self-contained ESM build of
source admission and rollout execution with its SHA-256. Hosted archives use
those published bytes instead of implementing a second source reader or loop.
The clean consumer check executes this distribution without module resolution.
