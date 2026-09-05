# 2026-09-05 Persistence Format and Consolidation

Status: Proposed architecture and implementation spec. Documentation only; no storage migration or runtime changes have been performed.

Latest checkpoint: 2026-09-05. The persistence design now includes the agreed upgrade experience: successful migration opens the app normally, and actionable problems appear at startup, in Settings or in the CLI where relevant. Preserving settings, credentials, history and schedule behavior is a release gate, not a promise of zero bugs. Next proof: complete the field-by-field migration inventory and validate the shared configuration writer before changing any live stores.

Related specifications:

- [Configuration and instruction rules](2026-09-05-configuration-and-instruction-rules.md)
- [Storage lifecycle and migration](2026-09-05-storage-lifecycle-and-migration.md)
- [Portable Profile releases](../../public/agents-and-skills.md)
- [Profile selection and composition](../../public/agents-and-skills.md)
- [Repository instructions](../../public/development.md)

## Summary

Make it possible to answer, for every persisted value: who owns it, where it lives, whether it is safe to edit or delete, how changes take effect, and how it is backed up. Desktop, web, TUI, CLI, and background workers must resolve the same settings through shared services.

Use TOML for human-edited operational configuration; Markdown and existing source formats for authored instructions and reusable packages; SQLite for mutable application records; versioned JSON for machine manifests and immutable receipts; JSONL for append-only logs and streaming exports; native files for artifacts and browser engine data.

"Consolidation" means removing competing authorities and duplicate persistence logic. It does not mean putting conversations, tokens, source packages, and UI dimensions in one TOML file. Existing public Profile, Agent SDK, and dataset formats remain explicit domain contracts.

## Current code review

These are observed implementation facts, not the proposed destination. Paths below are defaults; overrides and release channels can select other roots.

| Current store | Contents and observed concern | Code anchor |
| --- | --- | --- |
| `~/.openpond/config.json` | Account selection, endpoints, API keys, session references, execution settings, Profile library/check/push state mixed together | [cloud config](../../../packages/cloud/src/config.ts), [private JSON writer](../../../packages/cloud/src/private-json-file.ts) |
| Direct home-directory config read | Runtime separately reads `~/.openpond/config.json`; does not use the cloud loader's `OPENPOND_CONFIG_DIR` resolution | [runtime config](../../../packages/runtime/src/config.ts) |
| `<app-home>/providers.json` | User provider settings mixed with model caches and fetched hosted catalog | [provider settings](../../../apps/server/src/openpond/provider-settings.ts) |
| `<app-home>/provider-secrets.json` and `.key` | Encrypted local provider secrets; separate from account credentials still held in config JSON | [provider secrets](../../../apps/server/src/openpond/provider-secrets.ts) |
| `<app-home>/state.sqlite` | Sessions, events, approvals, training, schedules, subagents and other durable records | [base schema](../../../apps/server/src/store/store-schema.ts), [store core](../../../apps/server/src/store/store-core.ts) |
| SQLite `cache_entries` | Also holds durable app preferences, local projects and imported Codex sidebar preferences; deleting all cache entries would lose user choices | [preferences API](../../../apps/server/src/api/server-payloads.ts), [local projects](../../../apps/server/src/workspace/local-projects.ts), [Codex sidebar preferences](../../../apps/server/src/codex-history-sidebar-preferences.ts) |
| Browser local storage | Permission and reasoning overrides can take precedence over server values and sync back | [Codex preferences](../../../apps/web/src/lib/codex-preferences.ts), [command preferences](../../../apps/web/src/lib/openpond-command-access-preferences.ts) |
| Personalization files plus SQLite | Active template duplicated in JSON and cache entry; active `SOUL.md` rewritten during reads; templates found in multiple directories | [personalization](../../../apps/server/src/openpond/personalization.ts) |
| `~/.openpond/cache.json` | CLI/cloud app and tool cache distinct from server caches | [cloud cache](../../../packages/cloud/src/cache.ts) |
| `~/.openpond/extensions/registry.json` | Installed package registry plus materialized package files | [extension manager](../../../packages/cloud/src/extensions/extension-manager.ts) |
| `<app-home>/datasets/settings.json` | Dataset storage preference in its own JSON store; read errors currently fall back to defaults | [dataset storage](../../../apps/server/src/training/dataset-storage-service.ts) |
| Electron `browser-sidebar-state.json` | OpenPond tab metadata in a separate machine-written JSON file | [browser store](../../../apps/desktop/src/desktop-browser-store.ts) |
| Profile repository | `openpond-profile.json`, `profiles/<id>/settings/profile.yaml`, source, generated catalogs and package metadata | [local Profile](../../../packages/cloud/src/profile/local-profile.ts), [catalog](../../../packages/cloud/src/profile/profile-catalog.ts) |
| Harness and Refiner records | Revisioned memory in SQLite; Refiner source, immutable releases, transitions and binding JSON | [memory store](../../../apps/server/src/store/store-harness-memory.ts), [Refiner service](../../../apps/server/src/refiner/refiner-profile-service.ts) |
| Project action/template files | `openpond/project-actions.json` and `openpond.config.json` have application-specific schemas | [action config](../../../packages/actions/src/configuration.ts), [template config](../../../apps/server/src/workspace/workspace-config.ts) |
| Repository instructions | Root-to-working-directory `AGENTS.md` / `AGENTS.override.md`, canonical containment and bounded reads | [instruction resolver](../../../apps/server/src/openpond/repository-instructions.ts) |

The stable app home is currently `~/.openpond/openpond-app`; desktop nightly uses `openpond-app-nightly`. `OPENPOND_APP_HOME` and `OPENPOND_CONFIG_DIR` have different meanings today. See [server paths](../../../apps/server/src/paths.ts) and [desktop environment](../../../apps/desktop/src/desktop-environment.ts).

## Product decisions

1. Every persisted field has exactly one writable authority. API responses, in-memory snapshots, caches, generated prompts and exports are projections with an explicit source.
2. `config.toml` is the authority for user-selected defaults and local integration configuration. Settings UI changes edit the same file through the shared configuration service.
3. Runtime records and frequently changing UI state belong in typed SQLite tables. A table called `cache_entries` may hold only data that can be discarded without losing user decisions.
4. Credentials use one secret service for account login, BYOK, OAuth, refresh tokens and integration secrets. Config contains references or environment-variable names, never credential values.
5. Authored instructions stay readable as Markdown; executable permission policy stays typed and enforced by the runtime. Instructions and learned memory cannot grant tool access.
6. Existing portable source formats remain authoritative inside their packages. Local registration, activation, credentials and execution history stay outside published source.
7. Configuration reads have no persistence side effects. Initialization, migration, edits, activation and cache refresh are named operations.
8. Runtime code uses one new layout after cutover. One-time importers handle old stores; there are no permanent dual reads, dual writes or catch-all fallback loaders.
9. Successful automatic migration is silent: open the app normally with existing settings and data. No mandatory confirmation, success modal, generic migration warning or permanent banner. Surface only actionable problems in the relevant interface; document path/script changes in release notes.
10. Preservation of settings, credentials, history and schedule behavior is a release gate. Do not ship a migration that fails those checks. Testing establishes evidence for the normal upgrade path; it cannot guarantee that no user will encounter a bug.

The exact warning locations and recovery actions are specified in [Upgrade experience and warning locations](2026-09-05-storage-lifecycle-and-migration.md#upgrade-experience-and-warning-locations).

## One home directory

Resolve the home once at the process boundary: explicit `--home` > `OPENPOND_HOME` > release-channel default. Stable defaults to `~/.openpond`; nightly to `~/.openpond-nightly`. `pnpm dev` and tests receive an isolated explicit home. Pass the resolved absolute path to child processes and services; never recompute it deep in a package.

Nightly and stable do not concurrently mutate the same home. Startup checks the storage/config schema versions before acquiring write access. An explicitly shared home requires compatible versions and the same single runtime owner. Existing override variables are migration inputs only and produce a clear replacement diagnostic after cutover.

```text
<OPENPOND_HOME>/
  config.toml                    # human configuration
  storage.json                   # machine layout version + completed import ID
  instructions/
    user.md                      # global user-authored instructions
    personalities/<id>.md        # custom personality text
  state/
    state.sqlite                 # authoritative mutable application records
  secrets/
    credentials.json             # versioned encrypted credential records
    credentials.key              # protected local encryption key
    server-token                 # capability token for local client attachment
  library/
    profiles/<installation-id>/  # managed Profile checkouts
    extensions/<installation-id>/
    harnesses/<workspace-id>/     # authored harness source
    refiners/<refiner-id>/        # authored Refiner source
  artifacts/
    objects/sha256/<prefix>/<hash># immutable managed bytes, no user filenames
    manifests/<id>.json          # immutable versioned export/release receipts
  datasets/                      # default dataset bytes; external roots supported
  workspaces/                    # managed task dirs and worktrees, recoverable work
  cache/
    cache.sqlite                 # expendable remote/catalog cache
    generated/                   # compiled indexes and derived prompt material
  browser/                       # Electron/Chromium-owned engine profile
  runtime/                       # locks, endpoints, PID metadata, temporary files
  logs/                          # rotated structured JSONL
  diagnostics/                   # explicit redacted diagnostic bundles
  exports/                       # user-requested portable bundles
  backups/<migration-id>/         # protected migration/recovery snapshots
```

The tree names destinations, not an instruction to copy all existing data now. User-owned repositories stay at their current paths and are referenced by installation records. External datasets retain their bytes and recorded locations. `workspaces/` and `datasets/` are never treated as disposable caches. Profile source keeps its internal layout; browser engine files keep their native format.

## Persistence ownership matrix

| Domain | Authority and format | Scope / update rule |
| --- | --- | --- |
| Model, provider, reasoning, compaction, subagent, editor, training defaults | `config.toml` | User defaults; permitted project overrides; run snapshot records effective values |
| Account definitions, endpoints, explicit default account/Profile | `config.toml` | Local user configuration, stable IDs; no login/session history |
| Provider enablement, base URLs, credential references | `config.toml` | Local user only; remote catalog contributes discovery, not silent changes to selections |
| Global instructions and personalities | `instructions/*.md`; active personality selection in TOML | Human source; no writable active-Soul copy |
| Repository instructions | Repository `AGENTS.md` and `AGENTS.override.md` | Git-owned source; original hierarchy and applicability retained |
| Permission defaults, project restrictions, integration access settings | Typed TOML sections | Resolver enforces allowed scopes; trust and individual approvals remain state |
| Credentials, OAuth and refresh state | Encrypted credential JSON | Secret service only; partition by account, endpoint, provider and credential ID |
| Trust grants, tool approvals, capability leases | SQLite typed records | Account/project/tool scope and revision; no authority from cached prompts |
| Sessions, turns, events, queued messages, compaction summaries | SQLite typed records | Session/run lifecycle; resumable context is durable state |
| User drafts and unsent attachments | SQLite draft records + durable bytes | Debounced server save; browser staging is explicitly unsynced until acknowledged |
| Projects, registrations, installation records, last-used selections | SQLite typed records | Stable identity and canonical local path; user explicit defaults remain TOML |
| Pins, ordering, archives, layout, browser tabs, view state | SQLite typed UI records | Explicit device/client/workspace scope; never model permission defaults |
| Account teams/apps/catalog fetched from hosted services | Cache SQLite | Hosted service remains authoritative; TTL and account/endpoint partition required |
| Extension/Profile installation inventory | SQLite typed installation records + package source | Config may select/enable an installed ID; record owns installed revision and path |
| Profile, Agent, Skill, action and template source | Existing JSON/YAML/Markdown/TypeScript contracts | Git/package authority; source manifests are not alternate user settings |
| Harness memory and improvement proposals | Revisioned SQLite records | Existing revision checks, provenance and tombstones retained |
| Harness/Refiner releases and training evidence | Immutable JSON manifests + artifact bytes; activation in SQLite | Source revisions and hashes retained; activation is a transaction |
| Schedule/workflow definitions and run state | SQLite typed records; source-defined schedules remain source | Source definition is imported with identity/hash; explicit enablement and executions belong to state |
| Tasksets, evals, training/model runs, usage/accounting | SQLite records + immutable artifacts | Existing protocol contracts and audit identities retained |
| Dataset path preference | TOML `storage.datasets_dir` | New writes use validated location; existing objects retain recorded roots |
| Attachments, exports, datasets, trained models, reports | Native bytes + versioned manifest | IDs/hashes, lengths and media types; no raw bytes in TOML or giant SQLite JSON |
| Browser cookies, indexed databases, engine cache | Browser engine profile | Engine owns encryption/locking; OpenPond does not rewrite its files |
| Process endpoints, locks, PID files, build scratch | `runtime/` | Lease-bound; clean only after proving owner dead |
| Logs and diagnostics | JSONL / explicit bundles | Redacted, bounded retention; never sole source for resume or audit accounting |

Before a new persistence call is merged, its owner must supply: domain, authority, schema/version, scope key, writer, secret classification, failure behavior, retention, migration, and backup/export policy. Add fields to existing domain schemas instead of inventing another settings file or generic state bag.

## Implementation shape

Introduce a focused `@openpond/persistence` package for home resolution, configuration parsing/editing, safe file replacement, locks, secret storage, and storage diagnostics. Keep schemas in `@openpond/contracts`. Keep domain SQLite stores and runtime business logic with their existing server owners; this package must not become a universal object repository.

Split configuration into `schema`, `parse`, `resolve`, `edit`, `watch`, and `diagnostics` modules. Split credential encryption and credential ownership from the file writer. Reuse these APIs from `packages/cloud`, `packages/runtime`, the CLI and the app server.

One app-server runtime owns mutable application state and scheduling per home. Desktop/TUI/web and CLI state mutations use that runtime. Standalone config and login commands can use shared file services with interprocess locking; they must not start a second schedule worker. Startup races resolve through a home-scoped owner lock.

The existing Settings/preferences API may still return a composed view, but configuration writes and UI-state writes use distinct typed operations. Bootstrap includes configuration revision and provenance. The browser cannot overwrite server configuration from stale local storage on connect.

Detailed merge, instruction, conflict and reload behavior is in [configuration rules](2026-09-05-configuration-and-instruction-rules.md). File transactions, runtime records, deletion and the migration sequence are in [storage lifecycle](2026-09-05-storage-lifecycle-and-migration.md).

## Boundaries

- This is a local persistence architecture covering Desktop, local app server, TUI, CLI and local workers. Hosted service database migrations require their own implementation inventory; hosted resources continue to be authoritative remotely.
- Preserve the portable Profile/Agent SDK/dataset protocols. Converting those public source formats to TOML is not required to remove duplicate local settings stores.
- Do not migrate or modify Codex's own `~/.codex` directory. OpenPond-owned preferences about Codex follow this spec; Codex-owned history/auth/config retain their owner.
- No account sync service, distributed filesystem database, remote secret service or new natural-language rule engine is required.
- Documentation work must not read credential values, migrate the user's live data, change runtime settings or start schedules.

## Phases

### Phase 0 — Inventory and contracts

- [x] Review representative persistence paths and record authority conflicts. Done: code anchors in Current code review; read-only inspection on 2026-09-05.
- [x] Specify format families, source ownership, merge rules and migration acceptance. Done: this document and its two linked specifications.
- [ ] Enumerate every persisted field, cache namespace, browser key and handwritten file writer, including supplementary SQLite schemas. Assign each to the ownership matrix; no unknown durable keys may be dropped.
- [ ] Define root, config, secret, UI-state and provenance schemas; register existing domain schema versions without blanket version renaming.

### Phase 1 — Shared persistence foundation

- [ ] Implement home resolution, config schema, syntax-preserving TOML edits, conflict detection, locks and diagnostics.
- [ ] Consolidate credential access and validate secret-store recovery and references.
- [ ] Prove independent-process edits, invalid-file handling and protected scope resolution with the boundary tests in the linked specs.

### Phase 2 — Configuration and instruction consolidation

- [ ] Move user defaults and provider settings to the shared configuration service; split UI state and caches out of preferences.
- [ ] Route Desktop/TUI/CLI/bootstrap through the service; remove browser override sync and runtime raw JSON reads.
- [ ] Consolidate personalization selection and authored instruction sources; preserve repository hierarchy, Profile source and memory revisions.
- [ ] Implement file reload, provenance, recovery UI and per-turn configuration snapshots.

### Phase 3 — State and artifact consolidation

- [ ] Migrate durable cache namespaces into typed state tables and disposable data into cache storage.
- [ ] Consolidate installation/activation records, browser metadata, dataset preferences, secrets and hand-written file services.
- [ ] Implement artifact references, crash reconciliation, deletion/backup rules and scheduler recovery without replaying external effects.

### Phase 4 — Import, cutover and removal

- [ ] Build the explicit one-time import with dry-run reporting, backups, resumable checkpoints and conflict handling.
- [ ] Prove migration on isolated representative homes and the full Desktop/CLI edit/restart path.
- [ ] Prove silent successful upgrade and actionable startup/Settings/CLI recovery states; pass the data-preservation release gate before shipping.
- [ ] Remove retired loaders/writers, old environment-variable branches and legacy preference sync only after equivalent migrated behavior passes.
- [ ] Update public CLI/Desktop/development docs and installation packaging with the new home and recovery behavior.

## Validation

Passed for this spec: source inspection and review of related working docs. `python3 /tmp/openpond-persistence-spec-check.py` verified 3 documents, 57 local links, 1 TOML example parsed with `tomli`, one latest checkpoint per document, evidence on checked phase rows, and whitespace; 0 errors. This temporary authoring check is not an application test or shipped validator. The system Python lacks `tomllib`, so the check used the already installed `tomli` package; no dependency was added.

Implementation validation is pending. Run `pnpm typecheck`, the relevant existing store/config/provider/scheduler tests via the repository test runner, and the small set of new boundary tests specified in the linked docs. Run local application proof with `pnpm dev`; reuse an already running app when suitable. Never point migration tests at the real home.

No application tests or server startup are needed for this documentation-only change. No staging proof is claimed.

## Open questions

- The exact list of persistent fields and all disk locations remains a Phase 0 deliverable. Representative review does not establish that every writer has been found.
- Whether portable Profile settings should eventually converge from YAML to TOML is a separate source-format decision. This plan preserves their current contract and maps only declared defaults into config resolution.
- OS keychain support can replace local key-file custody later behind the same secret-service interface. Version 1 keeps the existing encrypted-file approach as its explicit backend.
- Remote settings sync and browser profile portability need separate product requirements. Version 1 defines local ownership and explicit exports only.

## Progress log

- 2026-09-05: Wrote the proposed architecture from repository evidence and existing Profile/instruction specifications. Runtime implementation and migration remain unchecked.
- 2026-09-05: Validated links, TOML syntax and working-doc structure with `python3 /tmp/openpond-persistence-spec-check.py` (0 errors). Files live under the repository's intentionally ignored `docs/working-docs/` directory; no ignore rules or Git staging were changed.
- 2026-09-05: Recorded the agreed warning placement and silent successful migration, with data-preservation checks required before release. Runtime behavior remains unimplemented.
