# 2026-08-30 Portable Profile Releases

Status: Focused implementation plan. OpenPond already has Git-backed Profile
source, selective publication, Git installation, Profile catalogs, setup gates,
and Agent/Skill discovery. The remaining work makes every Profile Release
directly downloadable and installable.

Latest checkpoint: 2026-08-30. Use the existing Profile repository as the
portable source format. Add a deterministic `.openpond-profile.zip` download,
a real `openpond.lock`, dependency closure and compatibility validation, CLI
and Desktop installation, and a one-action readiness check. The four continual-
RL examples will each ship one complete downloadable Profile.

Related docs:

- [Profile Selection and Source Publication](./2026-07-22-profile-selection-composition-and-public-sharing.md)
- [Enterprise Agent Scenario Packs and Continuous GRPO](../training/2026-08-30-enterprise-agent-scenario-packs-and-continuous-grpo.md)
- [Agents and Skills](../../public/agents-and-skills.md)

## Summary

A user should be able to download one Profile, install OpenPond Desktop or the
CLI/Harness, install the Profile, select it, and immediately use its Agents and
Skills. A self-contained example Profile should require no source edits.
If an Agent needs an external account or credential, installation should show
the exact setup requirement and become ready as soon as that connection is
configured.

The downloadable archive is not a new package system. Its contents are the same
readable Profile source OpenPond already uses:

```text
openpond-profile.json
profiles/<profile>/
  settings/profile.yaml
  openpond.lock
  agents/
  skills/
  actions/
  prompts/
  goals/
  evals/
  tasksets/
  examples/
```

GitHub or OpenPond Git remains the canonical update source when available. The
download is a deterministic archive of one pinned, sanitized publication
revision so the same Profile is easy to share from a blog, documentation page,
email, or local file.

## Current Code Review

- `packages/cloud/src/profile/local-profile.ts` already defines
  `openpond-profile.json`, `settings/profile.yaml`, Profile registration and
  selection, Agent/Skill discovery, setup gates, and local validation. It also
  creates `openpond.lock`, but that file is currently only a placeholder.
- `packages/contracts/src/profile-publication.ts` already models semantic Agent,
  Skill, and optional-content selection plus preview and publish results.
- `apps/server/src/profile-publication.ts` already creates a deterministic,
  sanitized source projection, rejects unsafe paths, symlinks, embedded
  secrets, missing tracked source, and size overruns, regenerates
  `openpond-profile.json`, and publishes a pinned Git revision.
- `apps/server/src/profile-installation.ts` already clones and updates GitHub or
  OpenPond Git Profile repositories and registers them without selecting or
  executing them.
- `apps/web/src/components/settings/ProfileSettingsSection.tsx` already lets a
  user add a Profile from a local path, GitHub, or OpenPond Git.
- `apps/web/src/components/settings/ProfilePublicationDialog.tsx` already lets
  an author select Agents, Skills, and optional content and inspect the exact
  publication files.
- `apps/cli/src/cli/profile.ts` can initialize, load, inspect, validate, run,
  commit, and sync a local Profile, but does not yet install a Profile from Git
  or an archive.
- `tests/profile-publication.test.ts` covers publication path and secret safety,
  but there is no full archive round trip or Git-install readiness test.

The existing implementation is therefore close. The gaps are packaging and
dependency closure, not a missing Profile model.

## Product Decision

### One Profile, two equivalent delivery forms

Every published Profile Release has:

1. a pinned Git source URL and revision; and
2. a downloadable archive named
   `<profile>-<short-revision>.openpond-profile.zip`.

Both materialize the same file tree and content digest. Installing either form
creates the same Profile reference and inventory. The archive is a convenience
transport, not a second source format.

### A real lockfile makes the source runnable

Replace the placeholder `openpond.lock` with a deterministic
`openpond.profileLock.v1` document containing:

- Profile ID, publication revision, and complete source digest;
- minimum compatible OpenPond CLI/Desktop and Harness protocol versions;
- exact Agent and Skill inventory with source hashes and resource files;
- action, workflow, tool, and extension dependencies;
- package-manager and released SDK dependency resolutions;
- setup requirement references without secret values;
- optional Taskset, eval, example, Reward recipe, base Model, and adapter
  references; and
- a sorted file checksum table for archive verification.

Publication must rewrite local-only SDK references such as `file:/...` to a
released compatible dependency or a safe vendored artifact. A Profile is not ready
when its package graph still points at the author's machine.

### Complete Profile is the showcase default

The existing selective publication controls remain useful. For the four
continual-RL examples, add a **Complete Profile** preset that includes:

- the selected Profile settings;
- every enabled Agent and its actions, workflows, tools, instructions,
  fixtures, and required package files;
- every enabled Profile Skill and all referenced scripts, templates, and
  resources;
- required prompts and safe configuration;
- example conversations;
- Tasksets, evals, grader/rubric source, and training recipe needed to reproduce
  the learning workflow; and
- immutable Model/adapter references when a public downloadable artifact is
  available.

Credentials, account bindings, private datasets, task history, schedules,
traces, local paths, runtime state, and secret values remain outside the
Profile Release.

### Install, validate, then use

The install flow is:

```text
Profile URL or .openpond-profile.zip
  -> preview inventory, compatibility, setup, and source digest
  -> verify safe paths, checksums, manifest, lockfile, and dependency closure
  -> install into the local Profile library without executing source
  -> restore released dependencies and build generated catalogs
  -> run inspect, build, validate, and bundled eval checks
  -> show Ready or exact setup requirements
  -> Use Profile
```

Installation never starts schedules or connects mutation-capable integrations.
Selecting the Profile makes its Agents, Skills, and actions available to Chat
and Work through the normal Harness.

## API, SDK, CLI, and UI Shape

### Contracts

Add provider-neutral contracts for:

- `ProfileKitManifest` and `ProfileKitFile`;
- export preview and export result;
- install preview, compatibility result, setup summary, and install result; and
- a stable installed-source reference containing provider, repository/archive
  digest, revision, and Profile ID.

### API and SDK

Extend the current Profile publication and installation APIs rather than adding
a separate package service:

```text
POST /v1/profile/publication/preview
POST /v1/profile/publication/publish
POST /v1/profile/publication/archive
POST /v1/profile/install/preview
POST /v1/profile/install
POST /v1/profile/update
```

`publication/archive` reuses the exact accepted publication plan and returns a
signed/downloadable artifact reference. `install` accepts a Git source, local
directory, uploaded archive, or downloaded archive reference.

### CLI

Add:

```text
openpond profile export --profile <id> --output <path>
openpond profile install <git-url-or-archive> [--profile <id>]
openpond profile install <source> --preview
openpond profile update <profile-ref>
openpond profile check --kind all
```

`install` prints the Profile inventory, source digest, compatibility result,
setup requirements, check results, and the command to select it.

### Desktop and public pages

- Add **Download Profile** beside **Publish** for an authored Profile.
- Add **Install Profile** and **Download** to public Profile source pages.
- Let an archive be dropped onto Settings > Profiles.
- Show Agents, Skills, training/eval content, version, source, compatibility,
  required connections, and installed update state before installation.
- After a successful ready check, offer **Use Profile**.

## Four Example Deliverables

Each continual-RL example produces one complete downloadable Profile:

| Example | Profile ID | Included source |
| --- | --- | --- |
| Commerce Support | `commerce-support` | Support Agent, policy and resolution Skills, stateful tools, Tasksets, evals, and recipe |
| Internal Operations | `operations-resolution` | Incident Agent, runbooks, approval/remediation tools, fixtures, Tasksets, evals, and recipe |
| Internal Knowledge | `organization-assistant` | Grounded-answer Agent, retrieval Skills/tools, sample corpus, Tasksets, evals, and recipe |
| Legal Contract Review | `contract-review` | Review Agent, playbook Skills/tools, short synthetic matters, Tasksets, evals, and recipe |

The case-study and technical guide for each example link directly to its
versioned Profile. A reader can install it, inspect the source, run the bundled
checks, use the Agent in Chat/Work, and rerun the documented training workflow.

## Boundaries

- Keep Git source readable and canonical; do not introduce an opaque binary
  registry format.
- Do not bundle credentials, account/team bindings, private evidence, local
  paths, runtime state, or schedule enablement.
- Do not auto-run installed Agent source, setup scripts, or schedules before
  explicit selection and readiness checks.
- Do not add domain-specific package or install APIs for the four examples.
- Do not bundle the entire OpenPond Harness binary in every Profile; pin the
  compatible Harness protocol and install it through the normal OpenPond
  distribution.

## Phases

### Phase 1 - Lockfile and Dependency Closure

- [ ] Define and export `openpond.profileLock.v1` contracts.
- [ ] Resolve semantic Agent/Skill/resource/tool dependencies for publication.
- [ ] Normalize released SDK dependencies and block author-machine file paths.
- [ ] Add deterministic file hashes and Harness compatibility checks.

### Phase 2 - Deterministic Download

- [ ] Generate `.openpond-profile.zip` from the exact accepted publication
  projection and verify reproducible contents and digest.
- [ ] Add API/SDK download results and public/private authorization.
- [ ] Add Desktop **Download Profile** and publication-result download actions.

### Phase 3 - Previewed Installation

- [ ] Support Git URL, OpenPond Git, local directory, and archive install
  preview through one provider-neutral contract.
- [ ] Implement safe archive extraction, checksum verification, immutable
  source identity, dependency restoration, and catalog generation.
- [ ] Add CLI install/export/update commands and Desktop drag/drop installation.
- [ ] Run the complete Profile check and offer **Use Profile** when ready.

### Phase 4 - Ship the Four Kits

- [ ] Export, install into a clean temporary Profile library, validate, and use
  each of the four example Kits.
- [ ] Link each pinned Profile from its case study and technical guide.
- [ ] Verify update behavior from Release 1 to the simulated Week 1 release.

## Validation

- Passed: Profile repositories, Agent/Skill discovery, Profile setup gates,
  selective publication preview, sanitized Git publication, Git installation,
  Profile registration, and update paths already exist in the current tree.
- Passed: `tests/profile-publication.test.ts` covers the current publication
  path and secret filters.
- Pending: deterministic archive round trip, dependency closure, real lockfile,
  compatibility failure cases, CLI install/export, Desktop download, clean-
  device installation, and all four downloadable Profile proofs.
- Skipped: no Profile archive or remote publication was created while writing
  this plan.

## Open Questions

- Whether archive installation should retain an optional upstream Git URL for
  later updates or remain digest-pinned until the user installs a newer Profile.
- Whether public adapter weights live inside small Kits or remain content-
  addressed downloads referenced by `openpond.lock`.

## Progress Log

- 2026-08-30: Audited the existing Profile publication and installation path
  and defined Portable Profile Releases as a deterministic downloadable transport
  over the current readable Git-backed Profile source.
