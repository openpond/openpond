# 2026-09-01 Test Suite Inventory And Pruning

Status: rebased onto current `origin/master`, locally validated, and open for review in [PR #203](https://github.com/openpond/openpond/pull/203). CI is pending.

Latest checkpoint: 2026-09-01. [PR #203](https://github.com/openpond/openpond/pull/203) is open from implementation commit `cbe468a1`. Every tracked test on the rebased `origin/master` has a disposition below. This change removes 190 of 479 files (39.7%), 861 of 2,311 test declarations (37.3%), and 34,731 of 101,520 test lines (34.2%) while retaining security, persistence, public-contract, concurrency/lifecycle, algorithmic, and representative end-to-end protection.

## Summary

The suite had become difficult to understand because multiple testing layers independently froze the same feature: co-located domain tests, root projection tests, exact prompt/registry tests, SSR markup tests, and broad scenario proofs. The resulting 479 files included 364 files in a flat root `tests/` directory and more than 100,000 lines of test code.

This pruning is intentionally not a percentage-only deletion. Each test was inventoried and assigned a keep/delete disposition. Deleted coverage primarily asserted presentation markup, exact copy, registry composition, trivial state projection, one-off scenario naming, or feature behavior already protected by a stronger retained boundary. Retained coverage protects consequences that matter: data integrity, security and containment, public protocols, process behavior, non-trivial algorithms, lifecycle/concurrency, and a bounded set of end-to-end paths.

## Current Code Review

- `vitest.config.ts`: sixteen projects split tests by runtime needs, but project membership does not express why an individual test is valuable.
- `scripts/test-suite-manifest.ts`: 120 root tests were manually promoted to the system tier; 30 deleted entries are removed in this change.
- `tests/`: the flat root held 364 test files spanning UI copy, backend integration, helper logic, benchmark proofs, and old characterization coverage.
- `apps/server/src/**/*.test.ts`: co-located domain tests are retained because they are closest to the service invariants they protect.
- `packages/*/test`: package-owned tests are retained as public/package boundary protection.
- `AGENTS.md`: now records the test-value standard so the suite does not regrow through automatic one-test-per-change habits.

## Product Decision

A test must have a concise failure story. It belongs in the default suite when a failure would indicate a meaningful regression in a durable contract or boundary and existing coverage would not already catch it.

Tests are not required for exact prose, CSS classes, icons, registry ordering, trivial selectors, or implementation wiring. Those surfaces are covered by review, typechecking, builds, and stronger boundary tests. A reported regression should usually produce one focused test at the lowest durable boundary, not parallel tests at every projection layer.

## Implementation Shape

### Delete

- Root SSR/UI tests that compare static markup, CSS classes, icon names, or broad page composition.
- Exact system-prompt, capability-catalog, registry-enumeration, and instruction-copy assertions.
- Root projection and characterization tests duplicated by co-located server/package tests.
- One-off benchmark, marketing, legal-example, and historical feature-proof flows in the default suite.
- Tests of test harnesses, release presentation, and performance-budget formatting when the actual build/check already executes in CI.

### Keep

- Security, authorization, redaction, path-containment, and workspace-boundary tests.
- SQLite, migration, persistence, idempotency, queue, cancellation, and process-ownership tests.
- Public SDK, CLI, app-server, runtime protocol, schema, and provider-adapter contracts.
- Non-trivial parsing, normalization, resource search, streaming, grading, and lifecycle algorithms.
- A limited set of real filesystem/process/service and release smoke tests.

## Boundaries

- Production behavior is unchanged.
- No security, persistence, migration, public API, provider protocol, or process-ownership test was intentionally removed.
- Live tests and desktop harness scenarios remain available as explicit acceptance paths.
- The change does not add coverage quotas or meta-tests that would recreate the same maintenance problem.
- A second pruning tranche should be evidence-led; this PR establishes the policy and removes the clearest low-signal 40%.

## Phases

### Phase 1 - Baseline And Inventory

- [x] Record the tracked test-file, declaration, and line baselines. Done after rebase: 479 files, 2,311 declarations, and 101,520 lines.
- [x] Assign every baseline test file a keep/delete disposition. Done: see Full File Inventory.
- [x] Identify durable preservation boundaries. Done: security, data, public contracts, lifecycle/concurrency, algorithms, and representative end-to-end flows are named above.

### Phase 2 - Prune And Prevent Regrowth

- [x] Remove the clearest low-signal coverage. Done after rebase: 190 files, 861 declarations, and 34,731 lines removed.
- [x] Remove deleted system tests from the explicit tier manifest. Done: manifest entries now describe only tracked tests.
- [x] Add repository-level test-value guidance. Done: `AGENTS.md` requires a meaningful, non-duplicated failure story.

### Phase 3 - Validation And Delivery

- [x] Run repository and test-tier checks. Done: repository, hygiene, workflow, and tier checks pass.
- [x] Re-run affected and retained unit/system suites after rebasing the merged lifecycle-fixture changes. Done: focused conflicts pass; 121 unit files / 673 tests and 141 system files / 724 tests pass.
- [x] Run remaining integration, contract, Python, image, and release suites as their dependencies permit. Done: all retained lanes pass with exact evidence below.
- [x] Record the implementation commit and pull-request URL. Done: `cbe468a1`, [PR #203](https://github.com/openpond/openpond/pull/203).

## Validation

- Passed: `pnpm run repository:check`
- Passed: `pnpm run hygiene:check`
- Passed: `pnpm run test-tiers:check`
- Passed: `pnpm run workflows:check`
- Passed: `pnpm run typecheck`
- Passed after rebase: `OPENPOND_TEST_REUSE_PACKAGE_BUILD=1 pnpm run test:unit` — 121 files, 673 tests.
- Passed after rebase: `OPENPOND_TEST_REUSE_PACKAGE_BUILD=1 pnpm run test:system` — 141 files, 724 tests.
- Passed: `OPENPOND_TEST_REUSE_PACKAGE_BUILD=1 pnpm run test:integration` — 2 files, 13 tests.
- Passed: `pnpm run test:python` — 3 dataset-worker and 6 eval-telemetry tests.
- Passed: `OPENPOND_TEST_REUSE_PACKAGE_BUILD=1 pnpm run test:image` — 1 file, 1 test.
- Passed: `OPENPOND_TEST_REUSE_PACKAGE_BUILD=1 pnpm run test:contract` — 42 Node contract and 33 Agent SDK tests.
- Passed: `pnpm run test:release` — production web/CLI build and 2 installed-artifact smoke tests.
- Passed after rebase: focused cancellation and Model Run tests — 2 files, 12 tests.
- Passed after rebase: focused draft-store tests — 1 file, 2 tests.

## Open Questions

- After this PR has failure/churn history, should a second tranche consolidate the remaining large root conglomerates such as terminal, model-tool, and Codex-history coverage into co-located domain tests? This PR deliberately retains them because their security and protocol value is higher than the deleted tranche.

## Full File Inventory

This is the complete set of 479 tracked `*.test.*` and Python `test_*.py` files at the baseline. Tier describes the pre-change execution lane. “Delete” means removed by this PR; “Keep” means retained.

| File | Baseline tier | Disposition | Reason |
| --- | --- | --- | --- |
| `apps/cli/test/cli-command-reference.test.ts` | CLI unit | Keep | Public CLI behavior or distribution boundary |
| `apps/cli/test/cli-command-registry.test.ts` | CLI unit | Keep | Public CLI behavior or distribution boundary |
| `apps/cli/test/cli-common.test.ts` | CLI unit | Keep | Public CLI behavior or distribution boundary |
| `apps/cli/test/cli-desktop-test-command.test.ts` | CLI unit | Keep | Public CLI behavior or distribution boundary |
| `apps/cli/test/cli-headless-chat.test.ts` | integration | Keep | Public CLI behavior or distribution boundary |
| `apps/cli/test/cli-installed-smoke.test.ts` | release | Keep | Public CLI behavior or distribution boundary |
| `apps/cli/test/cli-launch-mode.test.ts` | CLI unit | Keep | Public CLI behavior or distribution boundary |
| `apps/cli/test/cli-node-runtime.test.ts` | CLI unit | Keep | Public CLI behavior or distribution boundary |
| `apps/cli/test/cli-project-actions.test.ts` | CLI unit | Keep | Public CLI behavior or distribution boundary |
| `apps/cli/test/cli-project-agent-sandbox.test.ts` | integration | Keep | Public CLI behavior or distribution boundary |
| `apps/cli/test/cli-sandbox-runtime-lifecycle.test.ts` | CLI unit | Keep | Public CLI behavior or distribution boundary |
| `apps/cli/test/cli-sandbox-secrets-redaction.test.ts` | CLI unit | Keep | Public CLI behavior or distribution boundary |
| `apps/cli/test/cli-sandbox-template.test.ts` | CLI unit | Keep | Public CLI behavior or distribution boundary |
| `apps/cli/test/cli-taskset-command.test.ts` | CLI unit | Keep | Public CLI behavior or distribution boundary |
| `apps/cli/test/cli-training-command.test.ts` | CLI unit | Keep | Public CLI behavior or distribution boundary |
| `apps/cli/test/hosted-chat.test.ts` | CLI unit | Keep | Public CLI behavior or distribution boundary |
| `apps/cli/test/opchat-smoke.test.ts` | CLI unit | Keep | Public CLI behavior or distribution boundary |
| `apps/cli/test/sandbox-template-helpers.test.ts` | CLI unit | Keep | Public CLI behavior or distribution boundary |
| `apps/cli/test/sandbox-template-schedules.test.ts` | CLI unit | Keep | Public CLI behavior or distribution boundary |
| `apps/server/src/api/routes/training-routes.comparison-series.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/api/session-taskset-names.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/harness/improvement-trigger-detector.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/harness/local-harness-evaluation-review.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/harness/local-harness-refinement-acceptance.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/harness/local-harness-refiner-context.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/harness/local-harness-refiner-worker.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/harness/local-harness-workspace-service.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/openpond/community-client.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/openpond/hosted-api-access.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/openpond/openai-subscription-auth.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/openpond/team-chat-client.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/openpond/team-chat-executor.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/openpond/work-runtime-service.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/openpond/work-tool-registry.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/project-actions/hosted-project-actions.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/refiner/refiner-profile-service.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/runtime/executable-search-path-bun-compat.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/store/store-harness-benchmark-retirement.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/store/store-model-project-training-setup-migration.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/comparison-series-training-recipe.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/dataset-imports/hugging-face.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/dataset-imports/materialize-worker.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/harness-refiner-benchmark-model.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/harness-review-taskset.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/learned-preference-reward-binding.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/managed-adapter-chat-runtime.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/managed-adapter-registry-client.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/managed-adapter-sync-service.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/managed-model-binding-coordinator.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/managed-reward-model-recipes.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/managed-rl-base-profile.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/managed-rl-local-rollout-executor.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/managed-rl-operator-access.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/managed-training-validation-tasks.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/model-comparison-series-service.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/model-comparison-series-store.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/model-project-hosting.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/openpond-managed-training-evidence.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/portable-model-run-terminal.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/preference-comparison-model-judge.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/preference-comparison-records.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/reward-model-launch-input.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/synthetic-collection-run.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/task-attempt-grader-evidence.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/tau3-retail-bridge.integration.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/tau3-retail-reward.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/training-service-runtime.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/training/visible-agent-reward-trajectory.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/work/work-evidence-service.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/work/work-output-service.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/server/src/work/work-sandbox-lifecycle-service.test.ts` | system | Keep | Co-located service/domain invariant |
| `apps/web/src/components/chat/HarnessRefinerReceipt.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `apps/web/src/components/labs/lab-primary-tab-state.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `apps/web/src/components/settings/HarnessEvaluationReviewSettings.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `apps/web/src/components/training/TrainingRunMetrics.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `apps/web/src/lib/chat-refiner-activity.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `packages/actions/test/project-actions.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/agent-runtime/test/protocol.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/agent-runtime/test/runtime.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/agent-sdk/test/artifact-index-contract.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/agent-sdk/test/channel-harness-contract.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/agent-sdk/test/negative-validation-examples-contract.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/agent-sdk/test/openpond-code-inspect-contract.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/agent-sdk/test/pilot-examples-contract.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/agent-sdk/test/primitive-contract.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/agent-sdk/test/runtime-harness-contract.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/agent-sdk/test/source-loader-contract.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/agent-sdk/test/validation-issues-contract.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/app-server/test/app-server.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/cloud/src/sandbox/smoke.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/evals/python/tests/test_telemetry.py` | Python | Keep | Package-owned public or domain contract |
| `packages/evals/test/benchmarks.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/evals/test/evidence.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/evals/test/execution-receipts.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/evals/test/learned-preference.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/evals/test/model-improvement-qualification.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/evals/test/preferences.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/evals/test/public-api.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/evals/test/rollouts.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/evals/test/telemetry-analysis.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/evals/test/telemetry.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/harness/test/evaluation-review.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/harness/test/public-api.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/harness/test/refinement-lifecycle.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/harness/test/refiner.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/runtime/tests/chat.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/runtime/tests/selectors.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/sdk/test/api-error.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/sdk/test/model-projects.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/sdk/test/profile-actions.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/sdk/test/project-actions.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/sdk/test/training.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/sdk/test/work.test.ts` | package | Keep | Package-owned public or domain contract |
| `packages/sdk/test/workflows.test.ts` | package | Keep | Package-owned public or domain contract |
| `python/openpond-datasets/tests/test_dataset_worker.py` | Python | Keep | Python worker/data contract |
| `tests/account-settings-section.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/active-workspace-view-state.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/agent-app-server-cli.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/agent-app-server-rpc.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/agent-improvement-git.test.ts` | system | Delete | Duplicate feature/scenario proof |
| `tests/agent-improvement-release.test.ts` | system | Delete | Duplicate feature/scenario proof |
| `tests/app-preferences.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/app-selection-state.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/app-server-lean-composition.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/app-shell-effects.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/app-startup-splash.test.ts` | unit | Delete | Presentation/SSR markup detail |
| `tests/app-state.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/app-toast.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/ask-user-native-runtime.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/authoring-command-routing.test.ts` | unit | Keep | Security, authorization, or containment boundary |
| `tests/authoring-tool-registry.test.ts` | system | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/background-worker-queue.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/base-model-candidates.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/begin-new-chat.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/benchmark-execution.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/benchmark-taskset-import.test.ts` | system | Delete | Duplicate feature/scenario proof |
| `tests/bootstrap-event-window.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/browser-control-queue.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/bundled-authoring-skills.test.ts` | system | Delete | Redundant helper or implementation characterization |
| `tests/byok-turn-runner-profile-tools.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/canonical-learning-loop-proof.test.ts` | system | Delete | Redundant helper or implementation characterization |
| `tests/capability-tool-registry.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/chat-actions.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/chat-agent-mention.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/chat-attachments.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/chat-command-activities.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/chat-control-messages.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/chat-deliverables.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/chat-file-links.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/chat-message-command-summaries.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/chat-messages-interrupted-turn.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/chat-messages.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/chat-stream-benchmark.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/chat-timeline-rows.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/chat-work-trace.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/ci-change-scope.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/client-payload-projection.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/cloud-api-core.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/cloud-environment-setup.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/cloud-private-persistence.test.ts` | system | Keep | Durable data or lifecycle invariant |
| `tests/cloud-project-actions.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/cloud-session-readiness-service.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/cloud-session-ready.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/cloud-workspace-lifecycle.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/codex-bridge-usage.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/codex-bridge.test.mjs` | Node contract | Keep | Process/public runtime contract |
| `tests/codex-history-file-index.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/codex-history-live-refresh.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/codex-history-revision.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/codex-history.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/codex-personal-skills.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/codex-status-service.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/command-artifacts.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/command-output-retention.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/community-contracts.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/community-realtime.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/community-ui.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/composer-attachments.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/composer-direct-command.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/composer-draft-store.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/composer-profile-skill-invocations.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/composer-repo-links.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/composer-slash-behavior.test.ts` | system | Delete | Redundant helper or implementation characterization |
| `tests/composer-steer-queue.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/connected-app-bundles.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/connected-app-chat-proof.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/connected-app-context.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/connected-app-executor.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/connected-app-product-proof.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/connected-app-tool-call-contract.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/context-compaction.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/context-usage.test.mjs` | Node contract | Keep | Process/public runtime contract |
| `tests/context-window-status.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/contracts.test.mjs` | Node contract | Keep | Process/public runtime contract |
| `tests/create-improve-projection.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/create-improve-taskset-lineage.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/create-pipeline-planner.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/cross-system-expert-bootstrap.test.ts` | system | Delete | Redundant helper or implementation characterization |
| `tests/cross-system-operations-environment.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/dataset-artifact-service.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/dataset-catalog-store.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/dataset-source-picker.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/desktop-backend-manager.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/desktop-browser-harness-dom.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/desktop-browser-harness-validation.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/desktop-browser-ipc-validation.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/desktop-dev-smoke-script.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/desktop-diagnostics-collector.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/desktop-harness-report.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/desktop-harness-runner.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/desktop-ipc-trust.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/desktop-navigation-policy.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/desktop-process-sampler.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/desktop-request-tracker.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/desktop-runtime-stage.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/desktop-server-compatibility.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/desktop-server-token.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/dev-runner.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/development-system-context.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/dpo-training.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/evals-harness-registry.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/event-stream-contract.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/experience-handoff.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/extension-skill-runtime.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/get-started-learning.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/github-extension-manager.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/goal-details-subagents.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/goal-runtime.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/harness-improvement-contracts.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/harness-learning-notice-preference.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/harness-model-improvement.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/harness-refinement-status.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/harness-refiner-benchmark-cancellation.test.ts` | unit | Keep | Cancellation and active-run lifecycle invariant refreshed on master |
| `tests/harness-refiner-benchmark-evidence.test.ts` | system | Delete | Duplicate feature/scenario proof |
| `tests/harness-refiner-benchmark-protocol.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/harness-refiner-benchmark-public-result.test.ts` | system | Delete | Duplicate feature/scenario proof |
| `tests/harness-refiner-benchmark-sequential-resume.test.ts` | system | Delete | Duplicate feature/scenario proof |
| `tests/harness-refiner-benchmark-sequential-stage.test.ts` | system | Delete | Duplicate feature/scenario proof |
| `tests/harness-refiner-benchmark-taskset.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/harness-refiner-observation-resume.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/harness-refiner-observation-taskset.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/harness-refiner-qualification.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/harness-workspace-contracts.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/hosted-benchmark-accounting.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/hosted-chat-compaction.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/hosted-profile-agent-materialization.test.ts` | system | Delete | Redundant helper or implementation characterization |
| `tests/hosted-request-budget.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/hosted-run-idempotency.test.ts` | unit | Keep | Durable data or lifecycle invariant |
| `tests/hosted-tool-protocol.test.mjs` | Node contract | Keep | Process/public runtime contract |
| `tests/hosted-tool-rollout.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/hybrid-workspace-session.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/incremental-chat-projector.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/lab-model-workspace.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/lab-models.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/lab-regressions.test.ts` | system | Delete | Redundant helper or implementation characterization |
| `tests/labs-phase-one.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/learned-preference-training-contracts.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/learning-signal-contract.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/legal-contract-review-example.test.ts` | system | Delete | Duplicate feature/scenario proof |
| `tests/lightweight-selectors.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/live-current-openpond-agent-create.test.mjs` | live | Keep | Process/public runtime contract |
| `tests/live-current-subagent-orchestration.test.mjs` | live | Keep | Process/public runtime contract |
| `tests/live-openpond-scaffold-loop.test.mjs` | live | Keep | Process/public runtime contract |
| `tests/live-opentool-deploy-cycle.test.mjs` | live | Keep | Process/public runtime contract |
| `tests/local-agent-profile-scheduler.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/local-image-tool-registry.test.ts` | image | Keep | Real process, filesystem, database, or service boundary |
| `tests/local-profile-controls.test.ts` | system | Delete | Redundant helper or implementation characterization |
| `tests/local-project-actions-turn-runner.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/local-project-actions.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/local-project-source-upload.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/logger-redaction.test.ts` | system | Keep | Security, authorization, or containment boundary |
| `tests/managed-calibration-artifact-renderer.test.ts` | system | Delete | Redundant helper or implementation characterization |
| `tests/managed-rl-calibration.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/managed-rl-local-rollout-executor.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/manual-compaction-usage.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/markdown-blocks.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/markdown-checkboxes.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/marketing-portfolio-managed-rl-rollout.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/model-binding-promotion-gate.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/model-dataset-association.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/model-project-training-setup-store.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/model-project-training-setup.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/model-registry-search.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/model-tool-registry.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/model-usage-normalization.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/model-usage-recorder.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/model-usage-store.test.ts` | system | Keep | Durable data or lifecycle invariant |
| `tests/native-skills-settings.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/native-tool-calls.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/notifications-settings.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/opchat-reasoning.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/opchat-runtime.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/openai-compatible-provider.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/openpond-account-cache.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/openpond-action-catalog-context.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/openpond-app-action-channel.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/openpond-command-access.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/openpond-direct-command.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/openpond-managed-training-adapter.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/openpond-organization-memory.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/openpond-organization-selection.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/openpond-resources.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/output-file-model.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/outputs-page.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/packaged-smoke-diagnostics.test.ts` | system | Delete | Redundant helper or implementation characterization |
| `tests/pending-chat-messages.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/performance-budgets.test.ts` | system | Delete | Redundant helper or implementation characterization |
| `tests/portable-evals-adapter.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/portable-evaluation-release-isolation.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/portable-local-runtime.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/portable-model-run-lifecycle.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/portable-training-server-dependencies.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/preference-persistence.test.ts` | unit | Keep | Durable data or lifecycle invariant |
| `tests/profile-action-catalog.test.ts` | system | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/profile-agents-section.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/profile-benchmark-git.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/profile-publication.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/profile-selection-transaction.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/profile-selection.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/profile-settings-section.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/profile-source-upload.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/project-actions-analytics-proof.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/project-agent-setup.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/project-links.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/project-target-actions.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/project-workflow-state.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/provider-bootstrap-summary.test.ts` | system | Delete | Redundant helper or implementation characterization |
| `tests/provider-diagnostics.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/provider-model-options.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/provider-scoped-payloads.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/public-assets.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/python-sandbox.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/release-plan.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/release-updates.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/release-version.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/release-workflow.test.ts` | system | Delete | Internal workflow-script string assertions duplicated by workflow checks and release smoke |
| `tests/remote-access.test.mjs` | Node contract | Keep | Process/public runtime contract |
| `tests/remove-openpond-account.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/renderer-perf-budgets.test.ts` | system | Delete | Redundant helper or implementation characterization |
| `tests/repository-source.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/resolved-training-bundle-release-isolation.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/reward-model-qualification-projection.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/reward-model-qualification-store.test.ts` | system | Keep | Durable data or lifecycle invariant |
| `tests/right-chat-panel-stack.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/right-chat-panels.test.ts` | unit | Delete | Presentation/SSR markup detail |
| `tests/right-sidebar-conversation-state.test.ts` | unit | Delete | Presentation/SSR markup detail |
| `tests/right-sidebar-file-source.test.ts` | unit | Delete | Presentation/SSR markup detail |
| `tests/running-session-state.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/runtime-event-bus.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/runtime-event-lists.test.ts` | memory | Keep | Real process, filesystem, database, or service boundary |
| `tests/runtime-event-store.test.ts` | unit | Keep | Durable data or lifecycle invariant |
| `tests/runtime-indexes.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/sandbox-env-normalization.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/sandbox-integration-client.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/sandbox-integration-ui.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/scheduled-work-page.test.ts` | unit | Delete | Presentation/SSR markup detail |
| `tests/scheduled-work-view-preference.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/scripted-chat-provider.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/server-cli-web-launch.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/server-event-page.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/server-http-route-table.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/server-http.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/server-lifecycle-registry.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/server-web-surface.test.mjs` | Node contract | Keep | Process/public runtime contract |
| `tests/server-work-queues.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/server-workspace-tools.test.mjs` | Node contract | Keep | Process/public runtime contract |
| `tests/session-state.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/session-store.test.ts` | system | Keep | Durable data or lifecycle invariant |
| `tests/session-title-service.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/settings-surface.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/sidebar-file-bookmarks.test.ts` | system | Delete | Presentation/SSR markup detail |
| `tests/sidebar-navigation.test.ts` | unit | Delete | Presentation/SSR markup detail |
| `tests/sidebar-preference-state.test.ts` | unit | Delete | Presentation/SSR markup detail |
| `tests/sidebar-rows.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/sidebar-session-projects.test.ts` | system | Delete | Presentation/SSR markup detail |
| `tests/sidebar-task-grouping.test.ts` | unit | Delete | Presentation/SSR markup detail |
| `tests/sidebar-task-list.test.ts` | unit | Delete | Presentation/SSR markup detail |
| `tests/signed-resource-url-cache.test.ts` | unit | Keep | Security, authorization, or containment boundary |
| `tests/signed-workspace-image-url.test.ts` | system | Keep | Security, authorization, or containment boundary |
| `tests/smooth-streaming-text.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/sqlite-backup-retention.test.ts` | system | Keep | Durable data or lifecycle invariant |
| `tests/sqlite-driver.test.ts` | system | Keep | Durable data or lifecycle invariant |
| `tests/sqlite-store.test.ts` | system | Keep | Durable data or lifecycle invariant |
| `tests/static-web-security.test.ts` | system | Keep | Security, authorization, or containment boundary |
| `tests/streaming-markdown-segments.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/subagent-child-lifecycle.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/subagent-contracts.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/subagent-progress-projection.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/subagent-store.test.ts` | system | Keep | Durable data or lifecycle invariant |
| `tests/system-browser.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/task-authoring-egress-approval.test.ts` | unit | Keep | Security, authorization, or containment boundary |
| `tests/task-authoring-provenance.test.ts` | system | Keep | Security, authorization, or containment boundary |
| `tests/task-creator-chat.test.ts` | system | Delete | Duplicate feature/scenario proof |
| `tests/task-creator-fast-path.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/task-creator-pipeline.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/task-creator-signal-materialization.test.ts` | system | Delete | Duplicate feature/scenario proof |
| `tests/task-drafts.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/task-evaluation-contracts.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/task-grader-execution.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/task-grader-primitives.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/task-miner-detectors.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/taskset-authoring-skill.test.ts` | system | Keep | Security, authorization, or containment boundary |
| `tests/taskset-draft-store.test.ts` | system | Keep | Durable data or lifecycle invariant |
| `tests/taskset-draft.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/taskset-generated-project.test.ts` | system | Delete | Duplicate feature/scenario proof |
| `tests/taskset-sdk-contract.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/taskset-work-assets.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/taskset-work-attempt-runner.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/taskset-work-generic-fixtures.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/taskset-work-parity.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/team-chat-agent-run.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/team-chat-error.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/team-chat-notifications.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/team-chat-realtime.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/team-chat-state.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/team-chat-view.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/terminal-events.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/terminal-interactive-state.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/terminal-one-shot.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/terminal-primitives.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/terminal-process-ownership.test.ts` | system | Keep | Security, authorization, or containment boundary |
| `tests/terminal-raw-input.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/terminal-scope.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/terminal-transcript-layout.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/terminal-websocket-auth.test.ts` | system | Keep | Security, authorization, or containment boundary |
| `tests/tool-output-spill.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/train-slash-command.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/training-activity.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/training-api-model-run.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/training-api-scorer.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/training-api-synthetic-preference.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/training-artifact-package.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/training-authoring-boundary.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/training-benchmark-actions.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/training-builder-contracts.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/training-bundle.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/training-chat-search.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/training-compatibility-sizing.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/training-execution-readiness.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/training-local-job-store.test.ts` | unit | Keep | Durable data or lifecycle invariant |
| `tests/training-navigation-ui.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/training-new-model-flow.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/training-run-detail-ui.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/training-start-recipe.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/training-taskset-delete.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/turn-runner-characterization.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/turn-runner-cwd.test.mjs` | Node contract | Keep | Process/public runtime contract |
| `tests/turn-runner-lifecycle.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/turn-runner-public-contract.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/update-openpond-account-config.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/url-and-path-helpers.test.ts` | system | Keep | Security, authorization, or containment boundary |
| `tests/usage-payloads.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/usage-settings-section.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/user-auth-footer.test.ts` | unit | Delete | Presentation/SSR markup detail |
| `tests/user-question-messages.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/voice-model-download.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/web-event-stream.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/web-search.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/work-agent-package-service.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/work-experience-navigation.test.tsx` | UI unit | Delete | Presentation/SSR markup detail |
| `tests/work-experience-policy.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/work-format-capabilities.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/work-output-service.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/work-sidebar-output-model.test.ts` | unit | Delete | Presentation/SSR markup detail |
| `tests/work-system-context.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/work-tool-registry.test.ts` | system | Delete | Internal wiring, copy, or derived-view characterization |
| `tests/workspace-actions.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/workspace-capabilities.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/workspace-command.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/workspace-diff-file-model.test.ts` | unit | Delete | Duplicate feature/scenario proof |
| `tests/workspace-diff-panel.test.ts` | system | Delete | Presentation/SSR markup detail |
| `tests/workspace-diff.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/workspace-environment-menu.test.ts` | unit | Delete | Redundant helper or implementation characterization |
| `tests/workspace-lsp.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/workspace-refresh-coordinator.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/workspace-sandbox-actions.test.ts` | unit | Keep | Focused algorithm, protocol, or lifecycle invariant |
| `tests/workspace-state.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/workspace-tool-git.test.ts` | system | Keep | Real process, filesystem, database, or service boundary |
| `tests/workspace-tool-requirements.test.ts` | unit | Delete | Internal wiring, copy, or derived-view characterization |

## Progress Log

- 2026-09-01: Audited test topology, representative large files, assertion patterns, suite manifests, CI execution, and duplicate feature proof stacks.
- 2026-09-01: Removed the initial low-signal tranche and added a durable repository test-value policy.
- 2026-09-01: Initial validation showed the retained release-workflow meta-test already disagreed with the real build command on `origin/master`; removed it because workflow validation and release smoke cover the durable boundary.
- 2026-09-01: Completed all retained test lanes, typecheck, repository policy checks, workflow validation, and release build/smoke locally before rebase.
- 2026-09-01: Rebased onto `02cf3bb2`. Restored the merged cancellation, draft-deletion, and export-approval cases because they protect lifecycle, data, and paid-operation invariants; retained deletions of exact release-script and SSR training-detail coverage.
- 2026-09-01: Post-rebase focused, full unit, and full system validation passed.
- 2026-09-01: Pushed `feat/test-suite-pruning` and opened [PR #203](https://github.com/openpond/openpond/pull/203) against `master`.
