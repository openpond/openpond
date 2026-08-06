# Harness package boundary

`@openpond/harness` owns portable, host-neutral Harness identities and state
transitions. Host applications own persistence, model streaming, provider
sessions, authorization, credential leases, local processes, and artifact
bytes.

## Dependency direction

`@openpond/evals` may depend on and re-export `@openpond/harness`.
`@openpond/harness` must never import `@openpond/evals` or an application
package. This keeps Harness releases usable without installing an evaluation
runner.

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
improvement evidence, tools, model identities, and traces. Evaluation execution
interfaces that bind a Harness to a Taskset and emit attempt receipts belong to
`@openpond/evals`.
