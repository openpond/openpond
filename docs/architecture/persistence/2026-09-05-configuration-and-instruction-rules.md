# 2026-09-05 Configuration and Instruction Rules

Status: Proposed contract. Parent: [Persistence format and consolidation](2026-09-05-persistence-format-and-consolidation.md).

Latest checkpoint: 2026-09-05. The proposed configuration contract now specifies Settings and CLI error placement alongside TOML shape, scopes, merge/reload rules and instruction ownership. Successful migration has no required notice. The parser, API operations and examples below are proposed interfaces, not implemented commands.

## Summary

One configuration service resolves user intent into a typed effective configuration. Every effective field carries its source and revision. Human-authored instructions follow a separate, explicit composition rule; they never act as executable access policy.

## Current code review

The migration starts from [AppPreferences](../../../packages/contracts/src/settings.ts), [subagent preferences](../../../packages/contracts/src/subagents.ts), [provider contracts](../../../packages/contracts/src/providers.ts), [account config](../../../packages/cloud/src/config.ts), [personalization](../../../apps/server/src/openpond/personalization.ts), and [repository instructions](../../../apps/server/src/openpond/repository-instructions.ts). Their existing limits and enum meanings must be accounted for in the migration mapping; a spelling change must not silently change behavior.

## Product decisions

### TOML syntax and schema

- UTF-8, LF on generated content, a final newline, and `schema_version = 1` in each configuration file. This version is independent of database and root-layout versions.
- Use snake_case TOML keys. Map explicitly to typed contracts; do not apply an unchecked recursive camelCase conversion to arbitrary provider or extension payloads.
- Omitted keys inherit. Defaults are defined once in the typed schema and are not all written on first launch.
- No TOML nulls, executable expressions, shell substitutions, general environment interpolation or implicit remote includes. Secret/environment references use named typed fields.
- Numbers use field-specific units (`*_ms`, `*_bytes`, `*_percent`); durations are nonnegative integers unless the domain requires a positive value. Timestamps in machine records are UTC RFC 3339 strings. TOML datetime values are rejected unless explicitly part of a field schema.
- Unknown keys, duplicate definitions, invalid types and unsupported schema versions are errors with source path and line/column where available. Nothing strips unknown keys and writes a partial replacement back to disk.
- Newer config versions are not writable by older clients. Recovery can display raw text and export diagnostics without running tools against a partially understood configuration.
- Use the existing domain constraints where applicable, including model identifiers, reasoning enums, compaction bounds and editor commands. Schema generation must produce editor documentation and a settings-field registry from the same definitions.

### Illustrative user file

This example demonstrates the proposed format. It does not change the current app's defaults or configure a real account.

```toml
schema_version = 1

[chat]
model = { provider_id = "openpond", model_id = "openpond-chat" }
steer_active_responses = true

[codex]
reasoning_effort = "high"

[permissions]
command_access = "ask"
codex_mode = "default"

[context_compaction]
auto_enabled = true
trigger_percent = 85
summary_model = "same_model"

[subagents]
enabled = false
delegation_mode = "manual"

[projects]
branch_prefix = "feat/"
new_project_directory = "~/Projects"

[editor]
language_servers = "auto"
diagnostics_while_editing = true
check_on_save = true

[editor.languages.typescript]
mode = "auto"

[training]
creation_mode = "customize"
auto_approve_evidence = false

[personalization]
active = "builtin:default"
user_instructions = "instructions/user.md"

[storage]
datasets_dir = "datasets"

[providers.custom-openai-compatible]
enabled = false
base_url = "https://api.example.com/v1"
credential = { source = "env", name = "EXAMPLE_API_KEY" }
```

Models are atomic tagged references, including the existing managed-model/deployment variants where needed. A provider/model pair cannot be assembled from different layers. A subagent or training model override uses an explicit `mode = "inherit"` or `mode = "custom"` plus a complete typed model reference. Optional values that need an explicit disabled state use a field-specific `mode`, never magic empty strings.

`personalization.active` accepts `builtin:<id>` or `custom:<id>`. Custom content resolves to `instructions/personalities/<id>.md`. Built-in text stays packaged with the app and carries its shipped revision. An explicit `personalization.mode = "disabled"` disables personality text; it does not disable product instructions or access policy.

Account entries are keyed by stable local account ID under `[accounts.<id>]`, with handle, normalized service endpoints and an optional secret reference. `[defaults]` may select `account_id`, `profile_ref` and `team_id`. Installation IDs and Profile refs resolve through the typed local library records. Last-used values belong to SQLite, not these explicit defaults. Preserve distinct accounts that share a handle but use different endpoints.

### Existing settings mapping

| Existing fields / source | Destination |
| --- | --- |
| `defaultChatProvider`, `defaultChatModel`, `defaultChatModelRef` | One `chat.model` reference; migration checks agreement and reports conflicts |
| `codexReasoningEffort` | `codex.reasoning_effort` |
| `codexPermissionMode`, `openPondCommandAccessMode` | `permissions.codex_mode`, `permissions.command_access` |
| `subagents`, `contextCompaction`, `training`, `editor` | Corresponding typed TOML sections; move all actual persisted subfields, not only the example |
| `defaultBranchPrefix`, `defaultNewProjectDirectory` | `projects.branch_prefix`, `projects.new_project_directory` |
| `defaultTeamId`, explicit default account/Profile | `defaults` selections |
| `steerActiveResponses`, `advancedWorkspaceControls` | `chat.steer_active_responses`, `ui.advanced_workspace_controls` |
| `sidebarWidth`, `diffPanelWidth`, `sidebarSectionsCollapsed` | SQLite client-layout state |
| Provider user settings | `providers.<id>` with typed credential reference |
| Provider `modelCaches`, `catalogCache`, connection errors/status | Cache or runtime state, never user TOML |
| Account API keys/session tokens | Secret service; runtime conversation/app refs become SQLite account-session records |
| `lspEnabled`, `executionMode`, `mode` in CLI config | Normalize into editor and runtime default fields with explicit conflict reporting; no second CLI-only policy |
| Profile catalog, last checks/pushes, last-used selection | SQLite installation records, operation receipts and selection state |
| Personalization active template and source files | One TOML selector plus one Markdown source per custom template |
| Dataset `datasetStorePath` | `storage.datasets_dir`; preserve existing artifact locations |

The complete migration manifest must extend this table for every persisted field found in Phase 0. Unmapped fields block destructive cutover.

## Implementation shape

### Layers and precedence

Resolve ordinary settings from lowest to highest:

1. Shipped defaults.
2. Declared defaults from the selected portable Profile, restricted to its documented model/agent/skill/runtime fields.
3. User `<home>/config.toml`.
4. Trusted project-root `<repo>/.openpond/config.toml`, restricted to project-eligible fields.
5. Persisted task-specific overrides, when resolving that task.
6. Explicit invocation/turn overrides, restricted to fields the caller is authorized to change.

Only the project root contributes TOML in version 1. Nested `AGENTS.md` instructions retain their current hierarchy; nested config discovery and named config preset files are not introduced. A selected Profile is a source package, not a hidden extra user-config directory.

Resolve account and Profile identity before loading Profile defaults: explicit invocation/task selection > user-configured default > last-used selection in SQLite > shipped initial selection. Profile defaults cannot select another Profile or account. Resolving a default does not change last-used state; an explicit selection operation does. This prevents circular resolution and distinguishes a pinned default from navigation history.

Permission enforcement is a separate calculation. Normalize provider-specific modes into capabilities, approval requirements and limits; apply all applicable restrictions to the requested setting. A task, Profile, repository, extension or memory record cannot weaken the host/user authorization boundary. Incomparable modes such as Codex `auto-review` are not ordered by string or integer rank.

Configuration resolution must not read or merge Codex's own TOML. The Codex adapter maps explicit OpenPond options through supported provider APIs, and reports any provider-side constraints it can observe.

### Scope rules

| Scope | Allowed settings |
| --- | --- |
| User only | Accounts, credential references, provider endpoints, process/network binding, dataset roots, local library locations, global instruction paths and explicit user defaults |
| User and trusted project | Models, reasoning, compaction, editor behavior, branch prefix, project agent/subagent defaults and additional restrictions |
| Task/turn | Model and reasoning choices, selected installed Profile/agent, authorized task execution choices; never host paths, endpoints or credential definitions |
| State only | Project trust decisions, approvals, last-used selection, runtime status, auth status, installation receipts and UI layout |

Project config is ignored until the user has trusted the canonical project root. Trust is stored outside the repository, scoped to root/account and revocable. Trust to load config does not grant automatic execution of arbitrary custom commands or access to additional credentials. A changed executable configuration or credential mapping must pass the existing capability/approval checks before use. A symlink may not route project settings or instruction references outside the trusted root.

An untrusted project's ignored config produces a diagnostic. A trusted project's malformed config blocks new turns using that project until corrected. Other projects remain available.

### Merge and deletion

- Merge structured tables recursively by key; a scalar replaces the lower-layer scalar.
- Arrays replace in full; no append, index-based merge, or implicit deduplication. Order is meaningful only where the field contract says so.
- Named maps such as providers, accounts and roles merge by stable ID. A declared `enabled = false` disables an inherited entry. Removing a local override reveals the inherited entry; it does not delete the lower-layer source.
- Tagged unions and model/credential references replace atomically. Do not retain fields from another variant after changing its tag.
- Reject a field in the wrong scope even if it is valid in user config. Do not silently ignore it.
- API edits use explicit `set` and `unset` operations with key-path segments. `unset` removes the selected layer's key. A key-path string must not misinterpret a provider ID containing dots.
- UI shows "Inherited from …", "Set here", "Restricted by …", and "Applies next turn" where relevant. Reset means remove the override from the chosen scope.

### Paths and environment variables

Resolve relative user-config paths against the home and relative project paths against the canonical project root. Resolve source package paths against their package root. Expand `~/` only in user-owned local path fields. Do not expand `$VAR`, `%VAR%`, command substitutions or globs unless a specific typed domain field explicitly defines a glob.

Read environment variables only through registered process options or named credential/action references. Environment values are invocation inputs, not values silently persisted back to TOML. Scope cache and credential use to the full normalized service endpoint, account and credential identity/version; do not key on hostname alone.

Home resolution is a launch option only and cannot be redefined inside the config it locates. For other explicitly registered process options, precedence is launch flag > registered environment option > user config > shipped default. Each option declares its scope and restart requirement; arbitrary `OPENPOND_*` variables do not implicitly override similarly named keys.

Project action environment mappings remain owned by `openpond/project-actions.json`; template parameters remain owned by `openpond.config.json` and their existing schema. They are not duplicated into project TOML. These mappings may refer only to host variables already exposed by the trusted action/credential service. Copying a repository does not grant access to all process environment variables.

### Shared edit API

Proposed service operations:

```text
readConfig(scope, context)
  -> rawRevision, effectiveRevision, values, provenance, diagnostics
patchConfig(scope, expectedRawRevision, operations)
  -> newRawRevision, effectiveRevision, changedPaths, applyStatus
validateConfig(scope, text, context)
  -> diagnostics, effectivePreview
watchConfig(context)
  -> revision events with changedPaths and applyStatus
```

`rawRevision` is SHA-256 of the exact target file bytes, or a distinct missing-file sentinel. `effectiveRevision` hashes the normalized resolved values and ordered source revisions without secret values. Provenance records layer, canonical path/source ID, source hash and explicit/default status. Revision tokens are concurrency identifiers, not authentication credentials.

Validate an edit, take the interprocess file lock, reread and compare the revision, edit the syntax tree, validate the resulting effective configuration, then atomically replace the file. Return conflict without writing when the revision changed. Preserve comments, unrelated keys and ordering. Do not retry by sending an entire stale settings object. Check the file again immediately before replacement for non-cooperating external editors; report the remaining race honestly, since ordinary editor writes do not participate in our lock. Watcher reconciliation must detect subsequent edits.

Use a syntax-preserving TOML implementation proven by a comment-preservation round trip before choosing a dependency. If the serializer cannot preserve an input construct, reject the edit with an actionable diagnostic; never quietly rewrite the file and discard content.

Credential writes use the credential API, not the config patch API. Error messages and provenance never include secret values or raw environment contents. User-only settings mutations require the existing authenticated local settings capability; a generic project file edit does not imply that capability.

### Reload and active tasks

- Watch containing directories so editor rename/save works. Debounce notifications, reread the complete file and validate before publishing one new effective revision. Revalidate at new-turn boundaries so missed watcher events cannot keep stale policy indefinitely.
- Pin resolved model, instructions, Profile release, tool definitions and config/source hashes at turn start. Mid-turn changes do not replace an in-flight model request.
- Before each external/tool operation, also check current revocations and tighter permissions. An active turn cannot retain a revoked credential, project trust grant or capability solely because its snapshot once allowed it.
- Model/editor/general-default changes apply at the next relevant operation or turn. Explicit task overrides remain in force until reset. Existing schedule runs keep their captured definition; future claims use current definitions and enablement.
- Process listener/home changes require restart and are shown as pending; changing dataset preference affects new writes only. Moving existing datasets is a separate storage operation.
- A malformed global file at startup opens a recovery/settings surface and blocks new agent runs. A malformed edit while running preserves the last valid in-memory snapshot for display and non-executing reads, reports the error, blocks new turns and new tool launches, and allows cancellation/recovery. Never substitute permissive built-in defaults.
- Missing optional config initially uses defaults. Deliberate removal of a config layer is an observable change; recompute scope/policy and notify clients. Unreadable files and missing required referenced sources are errors, not "missing optional config".

### Configuration error presentation

Show an actionable banner in Settings when configuration is invalid, with the file, line/column when available, concise explanation, affected scope and an Open config action. Offer recovery only when a validated prior revision or backup exists; do not present a Restore action that silently substitutes shipped defaults. Keep Settings, cancellation and recovery accessible while affected execution is blocked.

If the user attempts an affected task outside Settings, show an inline explanation with a link to the same issue. Do not require the user to discover a hidden Settings banner to understand why a task cannot start. Project-only errors identify that project and leave unrelated work available.

CLI failures appear in the terminal with a stable error code, affected path/key and actionable next step; commands that cannot proceed return nonzero. Diagnostics for retired environment variables name the replacement. Machine-output mode returns a structured error without polluting its output with human warning text. Never display credential values or raw environment contents.

Resolve and remove the banner when corrected configuration validates. Watcher repeats of the same error do not generate stacked toasts or repeated modals. A successful automatic migration creates no Settings warning. See [Upgrade experience and warning locations](2026-09-05-storage-lifecycle-and-migration.md#upgrade-experience-and-warning-locations) for startup and release-note behavior.

## Instruction, rule and memory ownership

| Content | Canonical source | Composition / mutation rule |
| --- | --- | --- |
| Product/runtime behavior and enforcement | Shipped code and typed policy | User source does not rewrite this authority |
| Global user instructions | `<home>/instructions/user.md` | Optional human source; read without regenerating |
| Personality | Shipped template or custom personality Markdown selected in TOML | One selected source; built-in edits create a custom source |
| Profile/agent instructions and Skills | Existing selected Profile/agent/Skill files | Preserve source schema, selection and skill invocation semantics |
| Repository rules | `AGENTS.md` or `AGENTS.override.md` per directory | Existing root-to-working-directory selection for local Development tasks |
| Learned memory | Revisioned SQLite memory records | Facts/preferences with provenance and tombstones; not a second instruction-file authority |
| Refiner proposals and releases | Proposal state and immutable release artifacts | Review/validation/activation boundaries retained; no silent overwrite of human source |
| Permission/approval rules | Typed configuration plus runtime trust/approval records | Enforced in code; prose cannot grant access |

Composition records named sources instead of flattening everything into an untraceable prompt string. Within customizable behavior, apply personality, global user instructions, selected Profile/agent instructions, applicable repository instructions, then scoped memory/context, preserving source roles. More specific repository instructions apply within their directory; memory provides evidence/context and never wins an instruction conflict. The user's explicit task instructions control task-specific choices subject to runtime restrictions. Required provider formatting remains the adapter's responsibility.

Retain the current repository resolver's canonical boundary, same-directory preference for `AGENTS.override.md`, root-first order, diagnostic handling and 64 KiB per-file read safeguard. Preserve local Development applicability; do not inject repository rules into unrelated Chat/Work tasks. Deduplicate the same canonical instruction source; identical text in different source files remains separately attributed. Missing optional repository instructions do not fail a task; unreadable/rejected files produce visible diagnostics. Explicit configured required instruction paths fail validation if unavailable.

No new catch-all `rules.md`, writable generated `SOUL.md`, parallel `memory.md` database mirror, or alternative `rules.json` is introduced. Reusable workflows stay Skills; reusable roles stay agents; author-controlled package manifests retain their format.

### Consolidating learned content

Consolidation may merge redundant memory entries or propose an instruction/Skill change, but must preserve source evidence, scope and revision history. The apply transaction records input revision IDs, resulting revision ID, operation/actor and any superseded entries. Conflicting entries become a reviewable proposal; recency or similar wording alone does not decide truth. Deleted entries must not reappear after compaction, restart or cache rebuild.

Follow the existing [Refiner boundaries](../../../packages/harness/src/refiner.ts): durable explicitly stated user preferences/decisions belong in memory; broad behavior in instructions; reusable workflows in Skills; reusable roles in agents. Do not promote raw task data, credentials or inferred personal facts. Existing user-configured review/activation requirements govern application; this spec does not create a new approval prompt for every routine edit.

## Validation

Implementation acceptance uses a few boundary tests with concrete failure stories:

- Scope/merge test: a malicious or malformed project layer cannot replace endpoints, obtain credentials or widen permissions; atomic model references cannot mix providers across layers.
- Writer test with separate processes: two clients editing one file cannot silently lose a saved setting; stale revision conflicts and interrupted writes preserve valid prior bytes and comments.
- Reload/run test: editor atomic rename is observed; next turn sees new values; active turn keeps model provenance while permission revocation takes effect before the next tool launch.
- Instruction/memory test: scoped overrides remain attributable and a superseded/deleted memory is not resurrected by consolidation or restart. Extend existing instruction and memory boundary coverage where it already protects this invariant.

No tests are required for exact prose, table ordering, CSS, key casing transformations alone or copies of the schema's trivial defaults.

## Open questions

- Dependency selection for a syntax-preserving TOML editor requires an isolated proof; do not promise comment preservation from a parse/stringify library without verifying it.
- Exact project-eligible fields and typed account/model variants must be generated from the final Phase 0 field registry before implementation is considered complete.

## Progress log

- 2026-09-05: Specified configuration and instruction behavior. All implementation acceptance remains pending.
- 2026-09-05: Added contextual Settings/CLI error presentation, accessible recovery and automatic clearing after resolution; no generic success warning.
