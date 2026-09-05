# 2026-09-05 Storage Lifecycle and Migration

Status: Proposed implementation contract. Parent: [Persistence format and consolidation](2026-09-05-persistence-format-and-consolidation.md).

Latest checkpoint: 2026-09-05. Added the agreed silent successful upgrade, contextual warning locations and data-preservation release gate to the storage/migration contract. No live data has been inspected or migrated; failure-injection, recovery and end-to-end upgrade proof remain required before cutover.

## Summary

Keep human settings, authoritative runtime records and disposable data separate while sharing low-level persistence primitives. A successful write must mean the chosen authority has committed. Multiple files and SQLite cannot be assumed to form one atomic transaction; operations spanning them need explicit preparation, commit and recovery.

## Current code review

- [Private JSON file helper](../../../packages/cloud/src/private-json-file.ts) already centralizes private writes and interprocess locks; extend/reuse its relevant guarantees rather than maintaining independent file queues everywhere.
- [Provider writer](../../../apps/server/src/openpond/provider-settings.ts) uses a per-process queue and temporary-file rename; this alone does not coordinate CLI and server processes.
- [SQLite store core](../../../apps/server/src/store/store-core.ts) already configures WAL, foreign keys, migrations and health checks. Preserve meaningful store invariants while replacing layout and ownership.
- [Memory store](../../../apps/server/src/store/store-harness-memory.ts) already uses expected revisions and a transaction; preserve those semantics.
- [Scheduler](../../../apps/server/src/agents/local-agent-scheduler.ts), [workflow scheduler](../../../apps/server/src/workflows/chat-workflow-scheduler.ts), and [training stores](../../../apps/server/src/store/store-schema.ts) carry execution state that must survive relocation without duplicate external work.
- [Refiner service](../../../apps/server/src/refiner/refiner-profile-service.ts) has source, releases, transitions and an active binding file. The proposed consolidation moves mutable activation/binding state to SQLite while preserving immutable release content and IDs.

## Product decisions

### Authoritative SQLite state

Use one `state/state.sqlite` per home for OpenPond-owned mutable application records. Retain focused domain stores and existing table contracts. New UI, installation, selection and activation records use typed tables or an explicitly typed domain document table with revision checks; do not replace `cache_entries` with an unrestricted `settings` key-value dump.

Maintain `PRAGMA user_version`, ordered transactional migrations, foreign keys, bounded busy retries and one scheduler owner. Use WAL with an explicit durability setting (`synchronous = FULL` for authoritative commits); document any future relaxation with its data-loss implications. Never require a transaction across the authoritative and cache databases.

Every durable record has a stable ID and domain scope. Mutable records that accept concurrent user edits have a revision and compare-and-set update. Runtime lifecycle transitions use guarded state changes and unique constraints. IDs are not authorization; account/project scope is checked on reads and writes. Scope hosted data to service origin/base path, account and team where applicable. Switching accounts does not reinterpret existing records under a different owner.

Preserve existing typed payload schemas and wire identifiers. New machine documents carry an explicit domain version, for example `schemaVersion = "openpond.installation.v1"` in JSON notation. Database schema versions, config versions and export/protocol versions evolve independently. Unknown future versions are not silently normalized to empty records.

### Configuration and file writes

For each mutable OpenPond-owned file:

1. Validate the requested operation and owner scope.
2. Acquire the shared interprocess lock with bounded timeout and owner metadata.
3. Reread current bytes and verify the expected revision.
4. Create an exclusive random temporary file in the same directory, apply private permissions, write fully and flush it.
5. Validate the candidate, replace the target atomically, then flush the directory where supported.
6. Publish the committed revision and release the lock. Clean abandoned temporary files only after proving their owner is gone.

Lock ownership uses a nonce/process identity and heartbeat where needed; wall-clock age alone must not break a live lock. A reader never sees a half-written document. Do not overwrite a symlink target or follow a new path outside the validated root during a managed write. A failed permission/flush/replace operation is not reported as a successful save. OS-specific durability limits must appear in diagnostics and be covered on supported platforms.

All app clients use the shared writer. External editors are not cooperative lock participants: a revision check catches observed changes but cannot guarantee compare-and-swap against an arbitrary concurrent filesystem write. The config watcher detects resulting divergence and surfaces a conflict; never advertise a stronger guarantee than the filesystem provides.

### Secrets

Consolidate account credentials and provider secrets under one service. `secrets/credentials.json` contains a versioned encrypted envelope per stable credential ID with algorithm/version, key ID, nonce, ciphertext and authentication tag. Reuse the existing authenticated-encryption primitive after review; authenticate account/provider/endpoint ownership as associated data so records cannot be reassigned by editing metadata. Use fresh nonces for each encryption.

`secrets/credentials.key` is the explicit version-1 key backend. Directories are owner-only (`0700`) and files owner-only (`0600`) on POSIX; use equivalent owner ACLs on Windows. Credential/key-file co-location protects against accidental plaintext disclosure, not a compromised user account. Never regenerate a missing key over an existing vault or replace an unreadable vault with an empty one; report a recovery error and preserve original bytes.

Config contains `{ source = "secret", id = "..." }` or `{ source = "env", name = "..." }`, not API keys or OAuth objects. OAuth expiry/refresh metadata belongs with the secret record; public connection status is a redacted projection. Serialize refresh for a credential across processes, persist rotated tokens before making them available, and reject refresh results superseded by logout/revocation.

For setup spanning the vault and config: create a new encrypted record first, commit the reference second, and publish success after both. Do not destructively update a still-referenced secret as preparation. An orphan credential is recoverable and can be collected only after reconciliation; a dangling reference prevents use and produces a clear setup error. Logout commits revocation first, cancels future use/refresh, then removes secret material and invalidates relevant cache entries. Running remote requests may already have been dispatched; do not claim logout can undo them.

Do not include raw secrets in settings responses, logs, diagnostics, ordinary exports, SQLite event payloads or configuration hashes. Store local server attachment tokens privately; remote/browser clients never receive the entire vault or its key. Browser session storage for an attachment token is a transport decision, not a second account-credential authority.

### Cache contract

`cache/cache.sqlite` and `cache/generated/` may contain only reconstructible data. Every cache family defines source authority, scope key, source/schema version, fetched/generated time, expiry and stale-use policy. Catalog/app/tool discovery defaults to a one-hour TTL unless its API contract requires another value. Generated indexes are keyed by source digest, not only modification time.

Cache eviction must not remove account selection, saved projects, pins, installed-source registration, approvals, memory, drafts, run receipts or active bindings. Authentication and authorization decisions never use stale cache as proof of access. Account/endpoint changes and credential revocation invalidate the corresponding partition.

Version-1 default cache budget is 512 MiB with least-recently-used eviction of unpinned entries. In-use generated objects stay pinned until the reader releases them. Cache deletion while stopped, or through the cache service while running, must leave the application correct with slower cold reads. Corrupt cache can be rebuilt; corrupt authoritative state opens recovery without silently replacing user history with a fresh database.

### Artifacts and source packages

Managed immutable blobs are addressed by SHA-256 of exact bytes, with a manifest containing domain schema version, object ID, byte length, media type, checksum, owner scope and creation provenance. Keep original filenames as validated display metadata, never as untrusted storage paths. Do not reserialize signed/hashed existing release documents merely to apply a cosmetic JSON convention.

For new cross-language JSON manifests requiring a digest, define canonical JSON encoding in the protocol and use one shared implementation (the existing Harness canonicalization where compatible). Define safe numeric ranges explicitly; do not hash engine-dependent floating-point rendering across implementations.

Write artifact bytes and immutable manifest to temporary paths, verify hashes, publish them atomically, then commit the SQLite reference. A crash before the DB commit creates an orphan, not a missing referenced artifact. For exports with multiple files, publish the bundle only after its manifest and all objects validate. Readers verify required content is available and report a missing/corrupt object rather than manufacturing empty output.

Datasets and models can remain at registered external roots without copying. Their manifests record storage-root ID plus safe relative path, or an explicit remote URI owned by its connector. Changing `storage.datasets_dir` only changes placement for future writes. Moving existing data requires copy, checksum verification, transactional reference switch and delayed cleanup; cross-volume rename is not an atomic move.

Source repositories, installed packages and worktrees stay readable directory trees. Installation state records source URL, resolved revision/hash, local root, schema compatibility and setup status. Installation does not start schedules or grant trust. Source manifests remain authority for declared package contents; the installation record is authority for local registration and activation.

### Runtime and schedule recovery

Persist schedule definitions/overrides, explicit enablement, run identity, leases, attempt state and completion receipts in SQLite. For source-defined schedules, keep source identity/revision separate from user enablement; source discovery cannot reset enablement or erase another installed Profile's schedules.

Claim due work transactionally with a unique occurrence key and owner lease. On restart, reconcile expired leases using the operation's idempotency key and any recorded external receipt. Do not blindly replay an external action whose outcome is uncertain. Mark it for reconciliation or user action when the provider cannot establish the result. Exactly-once external side effects are not guaranteed by a local DB transaction.

Persist the effective run configuration and source revisions without credentials. Capture selected model, Profile/agent/release, instruction source hashes, policy revision, scheduled definition revision and operation IDs. Historical snapshots are evidence, not an authority that can bypass current revocation. Compaction summaries and continuation context needed to resume work are durable records, not cache.

### UI and browser state

Use typed SQLite client-state records for sidebar dimensions, collapsed sections, view choice and OpenPond browser tab metadata. Keys include the owning user/account plus device/client/workspace identity as appropriate. Debounce noisy changes and flush on stable interaction boundaries. A layout conflict can use per-field last accepted server update; do not reuse that relaxed policy for permissions or defaults.

Browser local storage may hold a bootstrap hint or unsynced draft staging, tagged with owner and revision. Once the server acknowledges a value, the server is its authority. A reconnect does not replay stale permission/default choices. Surface unsynced drafts and retry them without treating old local data as a successful server save.

The browser engine owns cookies, sessions and on-disk database formats under `browser/`. Move its profile only while the engine is closed using platform-supported relocation. Keep engine data outside ordinary settings exports and cache cleanup. OpenPond tab metadata is not a second browser cookie/session store.

## Retention, deletion and backup rules

| Category | Version-1 rule |
| --- | --- |
| User config, authored instructions, source, history, drafts, datasets | No automatic deletion based only on age |
| Runtime scratch | Remove only after confirmed owner exit and no durable reference; stale PID alone is insufficient |
| Cache | TTL plus 512 MiB default budget; rebuildable and account-scoped |
| Logs | Rotate; retain up to 14 days and 256 MiB total, whichever limit requires earlier removal |
| Automatic diagnostics | Retain up to 7 days; user-exported diagnostic bundles follow export ownership |
| Exports | User-owned; no automatic removal |
| Artifact orphans | Collect only after a successful complete reference scan, no active import/export pins, and a seven-day grace period |
| Migration backups | Keep at least the latest two successful migration snapshots and all snapshots under 30 days old; never auto-prune the sole pre-cutover recovery snapshot |

Deleting a task/account/project follows domain ownership: revoke/cancel active work first, transactionally remove or tombstone owned records, then release artifact references. Shared objects remain while referenced. Deleting a registration does not delete a user-owned source repository or external dataset. Account logout removes authentication, not task history; account-data deletion is a separate operation.

For memory, retained tombstones/revisions prevent resurrection. For requested permanent content deletion, remove the content from live records, search indexes, derived exports under app ownership and caches; retain only content-free deletion identity if needed for reconciliation. Recovery backups and user-exported copies have their own retention, which the deletion UI must explain. Never claim local deletion removes a hosted service's records without invoking its deletion API.

Create SQLite backups with its backup API or a stopped, checkpointed database. Copying only the main file of a live WAL database is not a complete backup. A full recovery snapshot includes configuration, instructions, state DB, vault/key custody, installation references and referenced managed artifacts; external roots are listed with availability and inclusion status. Quiesce relevant writes or pin immutable revisions while assembling a consistent snapshot.

Ordinary settings exports exclude secrets, runtime state, machine paths and browser data by default and mark references that need rebinding. Full recovery backups are private and include secret material only under explicit backup scope; an exported full backup requires encryption with separately supplied key material. Restore validates versions, integrity, scope and object availability into a fresh home before activation. Missing external datasets are reported rather than silently redirected to an empty default directory.

## One-time migration and consolidation

### Inputs and deterministic mapping

The importer takes explicit source paths for old global config, selected app home and optional desktop browser metadata. It does not merge stable, nightly and dev stores automatically. If more than one plausible source exists, dry-run reports them and requires an explicit source selection before mutation.

| Source | Destination / conflict rule |
| --- | --- |
| Global `config.json` account settings | TOML non-secret definitions; credentials to vault; session refs and last-used selections to state |
| App-preference cache entry | TOML defaults plus typed UI state; preserve values, do not replace with today's shipped defaults |
| Browser permission/reasoning keys | Do not automatically import authority; report available stale overrides and remove obsolete keys only after the new server config is acknowledged |
| `providers.json` | User fields to TOML; discovered model/catalog data to cache; connection status stays a projection |
| Existing provider vault/key | Validate and import without exposing decrypted values in reports; conflicting credential ownership blocks import |
| Personalization cache + JSON + `SOUL.md` + templates | Preserve every distinct text; resolve the currently effective selection using old semantics and record the proposed selection; conflicting or unmatched active text is retained and reported |
| Local projects and Codex sidebar cache namespaces | Typed durable records with preserved IDs, ordering and archive state |
| Profile config catalog/check/push fields; extension registry | Typed installations/operations/last-used selection; source bytes stay at registered roots or verified managed destinations |
| Dataset settings | TOML placement preference; preserve artifact roots and check availability |
| Refiner binding/transitions and harness state | Typed activation/history records with the original release IDs/hashes; immutable source/evidence remains immutable |
| State DB and supplemental schemas | Migrate in place in the staged copy, preserving domain IDs, revisions, schedule enablement and audit records |
| Browser sidebar metadata | Typed client-state records; engine profile relocation is independent and requires the engine stopped |
| Project action/template and Profile source formats | Register as explicit source contracts; do not rename or rewrite their schemas in this migration |

Dry-run produces a redacted report of source paths/schema versions, field destinations, counts, conflicts, credentials presence, unavailable roots and estimated bytes. Durable keys/namespaces without a mapping block commit. Do not pick newest mtime as a universal winner. Browser state is not available to the server until its client connects; those clients retire old preference-sync code at upgrade and may show unsynced old choices for manual reconciliation, never silently push them.

### Commit protocol

1. Acquire migration exclusivity and stop/quiesce every writer and scheduler for the selected source home. Older processes do not understand the new lock; verify they have exited before continuing. Refuse migration if ownership cannot be established.
2. Inventory sources and take consistent, private pre-migration backups. Store the source revisions/schema versions in a journal. Do not alter source bytes during preparation.
3. Build the new layout in a staging directory on the target filesystem. Transform config, credential envelopes, database records and source references. Copy artifacts only where the move plan requires them; verify bytes and preserve external roots.
4. Validate schemas, foreign keys, database integrity, ownership, referenced source paths/hashes, schedule enablement and credential references. Compare effective old/new settings semantically, including disabled and inherited states.
5. Record `prepared` in a versioned migration journal, then install staged files while all runtimes remain stopped. File installation is recoverable but not globally atomic. A journal enumerates each move and its pre/post hash; no new runtime may start while it is incomplete.
6. Commit `storage.json` with the new layout version and completed migration ID only after every required destination verifies. Flush the completion record. New startup requires both a supported layout version and a completed journal; it never combines half-new config with old state.
7. Start one new runtime, verify effective settings and state continuity, then mark the migration `verified`. Leave source backups available and record their location in migration details without dumping contents or requiring a success notice. Record a clear retired-layout marker; do not launch older executables against the migrated home.
8. Remove old readers/writers from the application code. Old files can remain in protected backups, but are never consulted by normal runtime resolution. Cleanup is separate from migration success.

The journal states are `planned`, `backed_up`, `prepared`, `installing`, `committed`, `verified`, `failed`. Each step has an idempotent operation ID and source/destination digest. A crash resumes or restores using this journal; it does not restart an import against unknown partially transformed data. A failed import preserves evidence and blocks normal startup until it is recovered.

Before `committed`, recovery can restore the old layout from snapshots with all runtimes stopped. After the new runtime has accepted writes, downgrade requires a supported reverse migration or restoration into a separate home with explicit acknowledgement that newer writes are excluded. Do not offer a silent old-binary fallback.

For an existing user-edited target TOML file, never overwrite it as an incidental migration step. Dry-run produces a per-field conflict report; an explicit resolution map determines destination values. Migration must preserve unrecognized source data in backup even when implementation blocks on its classification.

## Upgrade experience and warning locations

The intended experience for most users is an automatic upgrade followed by the normal app, with existing settings, login and history intact. They do not need to understand TOML or approve routine migration steps. Success produces no mandatory modal, success toast, generic warning or permanent Settings banner. A slow migration may show neutral progress while startup completes; do not frame ordinary progress as a problem.

| Condition | Where it appears | Required behavior |
| --- | --- | --- |
| Successful automatic migration | Normal app startup | Open normally; keep migration/backup details available on demand in Settings troubleshooting |
| Migration fails or cannot complete | Startup recovery screen, before normal runtime begins | Name the concrete problem, state what remains preserved, and offer Retry or validated recovery actions; never claim no data changed unless the journal proves it |
| Multiple plausible old homes or conflicting settings require a choice | Startup migration screen | Show only the relevant choices and consequences; preserve source versions until resolution |
| Invalid configuration during use | Settings banner; inline link when affected work is attempted | Show the file/location and correction or recovery action; keep Settings and cancellation accessible; clear after successful validation |
| Invalid configuration prevents startup | Startup recovery/settings surface | Open the same issue details without starting affected execution; support correction and retry |
| Retired paths/environment variables, config errors or incompatible home in CLI use | Terminal / structured CLI error | Identify the replacement or recovery step; return nonzero if the requested command cannot proceed |
| Unsupported layout/schema encountered by a launcher or app version | Startup compatibility screen or CLI error | Refuse writes; explain supported update/restore paths without silently downgrading data |
| New paths and changes relevant to manually maintained scripts | Release notes and updated CLI/development docs | Document old-to-new mapping and backup/downgrade behavior; no general in-app warning for unaffected users |

Issues have a stable identity and affected scope. Show one persistent actionable issue rather than duplicate startup dialogs, banners and toast storms. Dismissal may hide a transient notification, but cannot pretend a blocking issue is resolved. Once the condition is corrected, clear it automatically after verification. Do not display secrets, raw config contents or unrelated implementation detail in the message.

If migration fails before the commit point, recovery may restore the original layout using the journal and backup. After commit/new writes, explain the applicable restore limitation instead of promising an automatic rollback. If a known issue cannot be safely recovered in-product, provide a redacted diagnostic export and a concrete support path. These controls are exceptional recovery surfaces, not extra steps on a successful upgrade.

## Validation and acceptance

### Release gate

Do not ship the migration until isolated upgrade/restart proof demonstrates preservation of effective settings, credential ownership/login usability, history and drafts, installed Profile references, and schedule enablement/execution behavior. Include external dataset locations and multiple account endpoints. Compare semantic values and durable identities; a syntactically valid TOML file or passing typecheck is insufficient.

Prove the ordinary successful upgrade opens without a modal or warning banner. Prove representative failure/conflict/invalid-config cases reach the correct startup, Settings or CLI surface, with usable correction/recovery actions and clearing on resolution. Exercise these states within migration and end-to-end boundary coverage; do not add tests for exact warning prose, CSS or icon names.

Any failure of preservation, interrupted-migration recovery or scheduler duplicate-execution checks blocks release. Record the tested platforms and supported source versions. This gate reduces risk and establishes evidence for most users' upgrade path; it is not a guarantee of zero bugs.

### Required proof

Existing coverage to inspect/extend: [account config updates](../../../tests/update-openpond-account-config.test.ts), [SQLite store](../../../tests/sqlite-store.test.ts), [session store](../../../tests/session-store.test.ts), [scheduler](../../../tests/local-agent-profile-scheduler.test.ts), [usage records](../../../tests/model-usage-store.test.ts), and existing harness revision/activation tests.

Required boundary proof:

- Migration fixture: mixed old config, durable cache rows, multiple accounts/endpoints, provider secrets, conflicting personalization, disabled schedules, browser metadata and external dataset roots preserve effective behavior and identity after import/restart. Unknown durable fields and incompatible versions stop safely.
- Failure injection at each commit step: interruption never opens a half-migrated home; repeated recovery is idempotent and preserves the sole usable backup.
- Cache reset: remove all cache storage and prove saved configuration, projects, approvals, memory, drafts and scheduled work remain intact.
- Credential lifecycle: concurrent refresh/logout cannot resurrect revoked credentials; wrong key/tampered ownership never becomes empty/default credentials.
- Runtime claim/restart: two launchers cannot execute one due occurrence twice through duplicate local claims; uncertain external outcomes enter reconciliation instead of blind replay.
- Artifact recovery: crashes before/after reference commit yield either complete referenced objects or reclaimable orphans; external-root changes never retarget old artifacts.
- One representative UI/CLI path: edit a setting in UI, observe CLI, edit TOML externally, observe next turn, restart, then verify preferences and history. Include a stale browser reconnect and an invalid TOML recovery.

Run `pnpm typecheck` and targeted tests using the repository's configured suites after implementation. Perform local UI proof with `pnpm dev` and an isolated explicit home; reuse an existing suitable app. Do not add tests for exact config prose, private table order or every generated projection when a stronger boundary test already covers the failure.

Documentation validation and source inspection are the only completed evidence in this change. Runtime, migration, backup and recovery checks remain pending.

## Open questions

- Complete the enumerated disk-writer/cache/browser-key inventory before finalizing the import manifest; the reviewed examples do not prove exhaustive coverage.
- Verify filesystem atomic replacement, locks, directory flush and private permissions on each supported desktop platform during implementation.
- Full-backup encryption format and key handoff need implementation selection before an export command ships; private local migration snapshots can use owner-only filesystem custody.

## Progress log

- 2026-09-05: Wrote storage lifecycle and consolidation requirements. No live data mutation, runtime startup or migration testing performed.
- 2026-09-05: Specified silent successful upgrades, startup/Settings/CLI warning locations, release-note scope and preservation/recovery release gates following the product discussion.
