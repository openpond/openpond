# Configuration, storage and recovery

Desktop, Web, CLI and TUI share one OpenPond home. Stable defaults to `~/.openpond`; nightly defaults to `~/.openpond-nightly`. Set `OPENPOND_HOME` or pass `--home <directory>` to choose another home. Development keeps its existing isolated home under `~/.openpond/openpond-app-dev` (nightly: `openpond-app-nightly-dev`).

## Settings and ownership

Open **Settings → Customization → Configuration** for the TOML editor, effective values, source provenance and verified configuration revisions. General and context controls on this page, along with provider, account and notification settings, use the same backing services as the CLI. Saving applies to the next turn. Current tool execution still checks revocation and trust.

| Data | Authority inside the home |
| --- | --- |
| User defaults, provider/account definitions, notification mode, dataset placement | `config.toml` |
| User instruction files and custom personalities | `instructions/` |
| Sessions, events, approvals, memory, drafts, schedules, saved projects, selections, UI layout and installation/activation records | `state/state.sqlite` |
| Account/provider authentication | Encrypted `secrets/credentials.json`, with local key custody in `secrets/credentials.key` |
| Local runtime attachment | `secrets/server-token` |
| Profile, Harness, Refiner and extension sources | Readable directories in `library/`, or registered external repositories |
| Managed immutable attachments | Content-addressed bytes and manifests in `artifacts/objects/`, with references in SQLite |
| Datasets, Tasksets, model outputs and release evidence | Their existing versioned source/artifact formats, at recorded managed or external roots |
| Reconstructible discovery/model catalogs | `cache/cache.sqlite` |
| Browser cookies and sessions | Chromium-owned storage under `browser/chromium/`; tab metadata is in SQLite |
| Process ownership and migration journal | `runtime/` |

Continuous Review enablement, cadence and execution receipts remain durable schedule records. Harness and Refiner source definitions remain authored files; active bindings and transition history live in SQLite. These are separate from user defaults. Changing the dataset placement preference affects future writes and does not move existing datasets.

Only one runtime may own a home. A second launcher reports the existing runtime. Interrupted scheduled work with an uncertain external outcome is paused for review instead of being blindly replayed.

## Editing configuration

```sh
openpond config path
openpond config get
openpond config set projects.branch_prefix 'feat/'
openpond config unset projects.branch_prefix
openpond config validate
openpond config effective
openpond config schema
```

`get` includes the raw revision. Scripts can supply `--expected-revision <revision>` for conflict detection. Use `--key-path '["providers","custom.example","enabled"]'` for keys containing dots. Changes use the same interprocess writer as Settings, preserve unrelated comments and reject stale revisions. External editors do not participate in that lock; the app checks observed file changes and blocks conflicting saves.

Omitted keys inherit defaults. Arrays and model references are replaced as units. For a model override, use `{ "mode": "custom", "ref": { "provider_id": "openpond", "model_id": "openpond-chat" } }`; `{ "mode": "inherit" }` restores inheritance where that field supports it. Consult `config schema` for accepted fields and values.

Project configuration lives in `.openpond/config.toml` under a canonical project root. Review it before `openpond config trust --project-root <path>`; use `untrust` to revoke trust. Project settings cannot supply account credentials, custom host commands or broader permission grants. `config effective --project-root <path>` reports accepted layers and ignored untrusted project settings.

Credentials are references to encrypted records or environment variable names. HTTP endpoint URLs cannot contain passwords, tokens or other authentication parameters. Ordinary settings exports omit credentials and machine-specific references and report values that require rebinding:

```sh
openpond config export --file settings.json
```

## Upgrading the previous layout

A normal upgrade automatically imports the unambiguous previous installation and opens the app without a success dialog. The source files remain preserved. The importer snapshots the database with SQLite's backup API, builds a candidate home, validates it and installs files using a resumable journal. It preserves history, saved choices, credential ownership, schedule enablement and source identities.

| Previous location | Current location |
| --- | --- |
| `~/.openpond/config.json` | Account definitions in TOML; authentication in the encrypted vault; selections in SQLite |
| `~/.openpond/openpond-app/state.sqlite` | `~/.openpond/state/state.sqlite` |
| `providers.json` and provider vault/key | TOML definitions, shared vault and disposable model catalog cache |
| App preferences in `cache_entries` | TOML user choices and typed SQLite layout records |
| `SOUL.md`, saved personality files and personalization selection | Preserved instruction files and a TOML selector |
| Profile/extension registration and Refiner activation files | Typed SQLite records; source and release bytes remain files |
| App `token` | `secrets/server-token` |
| Electron user-data directory | Verified browser profile copy under the selected home, while the old browser engine is stopped |

`OPENPOND_APP_HOME`, `OPENPOND_CONFIG_DIR` and `--store-dir` are retired runtime options. Use the single home option. To import an explicit previous installation:

```sh
openpond config migrate --home /path/to/new-home \
  --source-app-home /path/to/previous-app \
  --source-config /path/to/previous/config.json --dry-run
```

The dry run reports destinations, counts, credential presence, conflicts, external roots and estimated bytes without exposing credential values. Omit `--dry-run` to apply. Multiple candidates, unknown durable fields, unreadable credentials, active old runtimes and occupied destination databases block import. For a user-edited destination TOML file, supply `--resolution-file choices.json`, containing entries such as `[{"path":["projects","branch_prefix"],"choice":"existing"}]`; every conflicting field needs an `existing` or `imported` choice.

If preparation fails, correct the source, use `config restart-migration`, then retry migration. This keeps the abandoned snapshot. Once installation has started, use `config recover` to resume; preparation cannot be discarded. Unsupported versions refuse writes. Do not run an older executable against the new home.

## Recovery and backup

Invalid settings surface in Settings with their file location and correction action. Startup failures open an authenticated recovery surface before execution starts. CLI failures include a structured issue and return nonzero. A corrected file or completed recovery clears the issue after validation.

```sh
openpond config doctor
openpond config revisions
openpond config recover --revision <verified-revision>
```

Full recovery backups require the runtime to be stopped and a separately stored 32-byte encryption key (raw bytes or base64). Keep the key separate from the exported backup:

```sh
openpond config backup --file /backup/openpond.opbk --key-file /separate/key
openpond config restore --home /path/to/fresh-home \
  --file /backup/openpond.opbk --key-file /separate/key
```

Restore authenticates the encrypted archive, verifies file/object integrity and writes into a fresh home. It refuses to overwrite an existing home. External repositories and datasets are listed with availability and inclusion status; missing external data is reported. Browser engine storage is excluded from this export. After the new runtime accepts writes, restoring an earlier backup into another home excludes those newer writes; there is no automatic downgrade.

Configuration, source, history and user exports are not deleted by age. The disposable cache uses expiry and a 512 MiB payload budget; `config clear-cache` rebuilds discovery data without removing settings or history. Logs retain up to 14 days and 256 MiB. Referenced or pinned managed artifacts are protected from orphan collection, which also requires a complete reference scan and seven-day grace period. Migration snapshots retain at least two successful backups and all snapshots under 30 days old. User-exported diagnostic bundles are user-owned.

POSIX storage uses private file modes. Windows uses a protected owner ACL; Windows packaged distribution remains paused as documented in the [Desktop platform policy](desktop.md). Directory flush support differs by OS, and arbitrary concurrent external filesystem edits cannot be made transactional with app writes.
