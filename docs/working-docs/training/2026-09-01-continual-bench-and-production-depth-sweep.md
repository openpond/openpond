# 2026-09-01 Continual Support and Production-Depth Sweep

Status: Fresh develop-only P0–P8 execution is paused before a corrected P0
restart. Model Runs 57 and 58 and the no-signal P2 attempt are retained as
superseded diagnostic evidence, not valid P0–P2 results. The audit found two
training-correctness defects: rollout prompts were silently left-truncated at
4,096 tokens, removing the beginning of the retail policy, and the first
post-skip optimizer step in P0 reinitialized its trainable adapter instead of
resuming the latest applied checkpoint. P1 therefore inherited an invalid P0
artifact. No benchmark Evaluation Run has started.

Latest checkpoint: 2026-09-03 00:54 UTC. The worker now preserves the leading
system policy and original task while compacting only older interaction turns,
fails closed when the protected prompt cannot fit, and resumes the latest
applied optimizer checkpoint across no-signal group gaps. The portable GRPO
contract admits a 7,168-token prompt plus a 1,024-token completion within the
8,192-token worker context. The OpenPond run list and detail page now assign the
same training-only ordinal to an immutable Model Run; Run 57 no longer appears
as Run 76. Focused and full Managed RL tests, worker tests, Sandbox typecheck and
lint, OpenPond typecheck, and browser verification pass locally. The corrected
worker release and OpenPond changes still require commit, CI, deployment, and a
fresh P0 launch.

Product name: **Continual Support**. The inaugural Model Project display name is
**Retail Support**. Tau Retail is user-supplied Taskset, environment, grader, and
fixture data; it is not hardcoded product behavior.

Related working docs:

- `2026-09-02-daily-evals-intake-and-nightly-learning.md` owns the optional
  Evals intake and review experience.
- `2026-09-01-commerce-support-production-grader-and-comparisons.md` owns the
  deterministic retail-support grading contract.
- `2026-09-01-model-comparison-human-review-ui-cleanup.md` owns the broader
  Models information architecture.

## Outcome

Run one fresh, immutable P0–P8 comparison series that demonstrates whether
successive additive residual updates learn reviewed retail-support corrections,
generalize to sibling cases, retain prior behavior, and improve over the frozen
base. Training and lineage happen first. The full benchmark and external
reference evaluation happen only after every P0–P8 Model Version exists.

This is a develop workflow. It does not require a production deployment,
production promotion, or manual browser walkthrough before training.

## Current product boundaries

The three product surfaces have separate jobs:

| Surface | Purpose in this run |
| --- | --- |
| Model Comparisons | Authoritative P0–P8 protocol, lineage, benchmark progress, longitudinal scorecard, and final comparison chart |
| Evaluations | Raw Evaluation Run history, attempts, transcripts, traces, receipts, and failures |
| Evals | Optional issue intake, response generation, oracle inspection, human correction, and manual task queueing |

The automated sweep does **not** navigate through Evals, perform Human Review,
click `Queue tasks`, or click `Start training` for P0–P8. Those controls must
exist and remain testable, but they are not execution gates. The sweep can submit
the predetermined correction Tasksets directly through the canonical comparison
and training services.

There is no separate top-level Benchmarks product for this work. The immutable
benchmark protocol and scorecard belong to Model Comparisons. Evaluations is the
drill-down evidence surface, not the primary longitudinal view.

## Stable design decisions

- Use one Comparison Series for the Retail Support model lineage.
- Keep issue tasks, captured responses, expected outcomes, deterministic grader
  code, and grader fixtures in user-owned Taskset data.
- Treat the grader as the reward function: it deterministically inspects each
  rollout's tool trace and final state and returns the scalar reward used by
  GRPO.
- A rollout samples a task from the sealed Taskset. The task is static; the
  policy trajectory is on-policy and changes as weights update.
- Use a 7,168-token protected prompt budget and 1,024-token completion budget.
  The worker must retain the system policy, tool schemas, and original task;
  only old interaction turns may be compacted.
- Use `klBeta = 0.01` for the fresh P0–P8 series. Equal-reward groups still have
  zero normalized advantage and skip the optimizer; nonuniform groups apply the
  normal clipped policy loss plus the fixed-base KL penalty.
- Across no-signal gaps, require each applied step's parameter hash before the
  update to equal the previous applied step's parameter hash after the update.
  A missing or reset chain invalidates the produced Model Version.
- Do not require an accept/reject decision between P0 and P6. Intermediate
  entries may remain `candidate` while the next pass is trained.
- Resolve each P1–P6 parent from the immediately previous published Model
  Version, not from an accepted-head pointer.
- Publish a distinct Model Version for every pass before any automatic benchmark
  evaluation starts.
- Run the final benchmark matrix only after all nine Model Versions exist.
- Keep queue and start as separate backend states even when the agent performs
  both operations without browser interaction.
- Do not promote a model to production as part of this plan.

## Training graph

The residual blocks are additive. `P2 based on P1` therefore means that P2
contains the frozen P0 and P1 blocks plus its new trainable P2 block. The same
rule applies transitively through P6.

| Pass | Parent | New trainable rank | Enabled cumulative rank | Training source |
| --- | --- | ---: | ---: | --- |
| P0 | frozen base | 16 | 16 | seed correction task 18 |
| P1 | P0 Model Version | 1 | 17 | correction task 20 |
| P2 | P1 Model Version | 2 | 19 | correction task 27 |
| P3 | P2 Model Version | 3 | 22 | correction task 48 |
| P4 | P3 Model Version | 2 | 24 | correction task 85 |
| P5 | P4 Model Version | 1 | 25 | correction task 95 |
| P6 | P5 Model Version | 2 | 27 | correction task 111 |
| P7 | P0 Model Version | 11 | 27 | union of P1–P6 correction cohorts |
| P8 | frozen base | 27 | 27 | all sealed training-eligible corrections from P0–P6 |

P0 uses exactly 16 sequential optimizer groups. Each group samples four
trajectories from the P0 task, for 64 trajectories total. P1–P8 use the group
counts sealed in the new protocol; the preparation receipt must display each
pass's task count, groups per task, trajectories per group, and maximum rollout
count before it can be queued.

Parent resolution rules:

- P0: `base_model`
- P1–P6: `previous_release`
- P7: `seed_release` pointing directly to the published P0 Model Version
- P8: `base_model`

The fresh series must fail admission if a required parent lacks a published
Model Version. It must never silently fall back to the base model or an older
accepted head.

## Task and reward contract

Each training item must provide:

- the user request and initial environment state;
- the available tools and their schemas;
- the deterministic expected outcome or final-state contract;
- privileged grader configuration and fixtures;
- source and licensing provenance; and
- a stable task, Taskset, environment, and grader content hash.

The Tau task does not need a prerecorded policy response. During training, the
current Qwen policy receives the task and generates a fresh trajectory. The
managed RL harness passes the trajectory and resulting environment state to the
hash-pinned grader. Hardcoded checks such as required reads, confirmation before
mutation, tool errors, and final database state belong to that user-supplied
grader release. They do not belong in generic OpenPond server code.

Captured production responses may be imported through Evals for human review,
but they are optional inputs and are not required for the deterministic training
reward to function.

## End-of-sweep benchmark

Automatic evaluation remains enabled but gated until P0–P8 all have published
Model Versions. Publishing P0–P7 must not launch paid comparison work.

Once P8 is published, evaluate every P0–P8 candidate using the sealed protocol:

- its current correction cohort;
- same-family sibling verification cases;
- cumulative known-issue cases through that ordinal;
- the shared development panel;
- the shared retained-behavior panel; and
- the shared frozen-final panel.

The frozen-final panel must run for **every** P0–P8 point so the final chart is a
real longitudinal comparison, not a P8-only result. Candidate and paired-parent
runs use the same seeds and repetitions. External frontier references start only
after the complete candidate matrix is terminal, and appear as reference lines
in Model Comparisons.

The scorecard must report, from immutable receipts:

- correction and sibling pass rates;
- cumulative known-issue retention;
- retained and frozen-final regression;
- fixed, regressed, and unresolved task IDs;
- quality by P0–P8 Model Version;
- base and external-reference comparisons;
- latency, token use, GPU seconds, and realized spend; and
- links to raw Evaluation attempts and evidence.

Do not use an intermediate benchmark score to decide whether P1–P6 may train.
Review and interpretation happen after the full matrix is complete.

## Fresh execution plan

### Phase 0 — Implementation readiness

- [x] Rename the reusable package and CLI surface to Continual Support.
- [x] Keep Tau-specific grader code and example fixtures out of tracked generic
  application code.
- [x] Expose user-owned grader identity and source from Taskset detail.
- [x] Add `previous_release` parent resolution for decision-free cumulative
  P1–P6 training.
- [x] Prove P0 candidate → P1 candidate → P2 queueing without accept/reject
  decisions and with cumulative residual ranks.
- [x] Gate automatic evaluation until every scheduled pass has a Model Version.
- [x] Include the shared frozen-final panel for every P0–P8 point.
- [x] Defer external-reference evaluation until the candidate matrix is complete.
- [x] Pass root typecheck and focused Continual Support tests.

### Phase 1 — Prepare the fresh series

- [x] Validate the user-owned Tau Tasksets, grader fixtures, and pinned grader
  digest from the development data directory.
- [x] Produce a new split and leakage-audit receipt for correction, sibling,
  cumulative-known, development, retained, frozen-final, and training-eligible
  panels.
- [x] Create one fresh Retail Support Comparison Series and seal a new immutable
  benchmark protocol using the graph above.
- [x] Verify the preparation receipt contains no repository-owned Tau fixture
  paths and no stale P0–P8 result IDs.
- [x] Verify no automatic Evaluation Run exists before training begins.

### Phase 2 — Train P0

- [ ] Queue a fresh P0 entry from the frozen base and the sealed seed Taskset.
- [ ] Verify the admitted plan is 16 optimizer groups × 4 trajectories = 64
  trajectories.
- [ ] Verify the admitted recipe uses a 7,168-token protected prompt, a
  1,024-token completion, and `klBeta = 0.01`.
- [ ] Start P0 through the canonical Model Run path.
- [ ] Require a successful terminal receipt, a continuous applied-update
  parameter-hash chain across no-signal gaps, adapter
  artifact, and published rank-16 Model Version.

### Phase 3 — Train cumulative P1–P6

For each pass in order:

- [ ] Queue the predetermined correction Taskset directly; no Evals browser step
  is required.
- [ ] Resolve the parent to the immediately preceding published Model Version.
- [ ] Freeze all inherited blocks and train only the newly appended block.
- [ ] Verify cumulative ranks are 17, 19, 22, 24, 25, and 27.
- [ ] Publish the new Model Version before queueing the next pass.
- [ ] Confirm no automatic benchmark Evaluation has started.

### Phase 4 — Train P7 and P8

- [ ] Train P7 from P0 with a new rank-11 block on the P1–P6 correction union.
- [ ] Train P8 from the frozen base with a fresh rank-27 block on all sealed
  P0–P6 training-eligible corrections.
- [ ] Publish both Model Versions and verify all nine P0–P8 versions are durable.

### Phase 5 — Run final evaluations

- [ ] Reconcile the sealed benchmark once all nine versions exist.
- [ ] Run the paired candidate/parent matrix across required panels, seeds, and
  repetitions.
- [ ] Run sealed external references only after candidate runs are terminal.
- [ ] Confirm Model Comparisons shows all P0–P8 points and reference lines.
- [ ] Confirm Evaluations exposes every raw run, attempt, transcript, trace,
  failure, and receipt.
- [ ] Reconcile the final currency snapshots and scorecard.

### Phase 6 — Review and report

- [ ] Review fixed, unresolved, and regressed tasks after the complete sweep.
- [ ] Record quality, latency, token, GPU, and spend deltas from receipts.
- [ ] Optionally test the Evals intake/review UI with representative tasks; this
  does not retroactively gate or alter the benchmark.
- [ ] Preserve immutable series, protocol, Model Version, Evaluation, and
  evidence identities in the final report.
- [ ] Do not promote to production from this plan.

## Validation commands

Run before the fresh series is created:

```bash
pnpm run typecheck
pnpm exec vitest run \
  apps/server/src/training/model-comparison-series-service.test.ts \
  apps/server/src/training/model-comparison-evaluation-scheduler.test.ts \
  apps/server/src/training/model-currency-projection-service.test.ts \
  tests/continual-support-contracts.test.ts \
  tests/continual-support-package.test.ts
```

Run broader repository and integration checks in proportion to any additional
code changes before starting paid compute.

## Current checkpoint

There are no valid P0–P8 benchmark results under this plan. Run 57 sampled 64
trajectories from one P0 task across 16 groups, but only three groups had
nonuniform rewards. Its third applied step started from the initial trainable
parameter hash instead of the second step's output hash after a no-signal gap.
Every recorded prompt was also at the 4,096-token truncation ceiling; the first
turn dropped 654 policy tokens and a later 10,534-token turn dropped 6,438
tokens. Run 58 made one real rank-1 update on four P1 trajectories, but inherited
Run 57 and used the same truncated prompt path. The P2 attempt sampled four
trajectories with deterministic reward `-0.05` and correctly found no normalized
learning signal, but it also used the invalid parent and prompt path. All three
are superseded. Corrected P0 must start from the frozen base after CI and worker
deployment; training is not waiting on Evals UI proof or production promotion.

## Progress log

- 2026-09-02 20:23 UTC: Applied the staging compute metadata update and verified
  the corrected managed-worker image pin after two infrastructure-only P0
  attempts.
- 2026-09-02 21:11 UTC: H100 attempt
  `model_run_0e4587ab-8822-4627-b169-7868d56fbc05` reached a valid eight-turn
  Tau baseline but failed before optimization because the desktop completion
  boundary dropped the first seven `policyResults` from the multi-turn receipt.
- 2026-09-02 21:25 UTC: Preserved the complete multi-turn `policyResults` array,
  passed the focused regression test and root typecheck, restarted the desktop
  stack, and queued the replacement P0 run on the same warm H100.
- 2026-09-02 21:30 UTC: Replacement P0 accepted baseline reward `0.19` and
  committed optimizer step 1.
- 2026-09-02 21:33 UTC: Replacement P0 failed after the next nonuniform group
  trained successfully because skipped rollout groups made checkpoint step `4`
  diverge from expected learned-policy version `2`. Kept the transition guard,
  separated checkpoint step from output policy version in the worker command,
  added a skipped-group regression test, and began an immutable replacement
  image build while preserving the healthy H100 worker until replacement.
- 2026-09-02 21:53 UTC: Built and deployed corrected managed-worker release
  `1507cc1e850f3a770232f203d0d6457572c05ca60d9cf3a9c6873dfbedbf509c`.
  Cancelled one replacement attempt before rollouts after detecting that its
  allocation still carried stale compute startup metadata, then applied the
  exact in-place compute metadata update and passed the staging control-plane
  canary.
- 2026-09-02 21:58 UTC: Queued P0 attempt 9 on a fresh H100. Both persisted
  allocation and physical-worker records carry corrected digest
  `164382f8aeb8a0be0ba48fdbe6f5949c648f03d13548b5ae4ef6d3b0dd44f5c9`;
  image installation completed and the worker entered model bootstrap with no
  reported failure.
- 2026-09-02 22:09 UTC: Attempt 9 admitted all four multi-turn trajectories in
  its first group with two distinct scalar rewards, proving the receipt fix in
  live execution. It failed before optimizer work because the worker validated
  `outputPolicyVersion` against a nonexistent `trainingBatch.policyVersion`
  field. Added explicit command-level input/output policy versions, bound every
  trajectory lineage item to the input version, and kept the transition guard.
- 2026-09-02 22:28 UTC: Passed 208 Managed RL tests, 47 worker tests, typecheck,
  lint, source-attestation, and staging CI; built worker digest
  `c150d815488a30db00739887ac46010685301c5e9ab318dfaa4d6cfe1d06d517`;
  deployed Sandbox revisions `05537126a` and `f765094d5`; applied the exact
  in-place compute metadata update with zero creates or destroys; and passed the
  restarted private control-plane canary.
- 2026-09-02 22:29 UTC: Terminated and reconciled only the immutable bad-image
  attempt-9 pod, then queued attempt 10. Its new H100 allocation and physical
  worker both persist the corrected digest before assignment.
- 2026-09-02 22:39 UTC: Attempt 10 completed private-R2 model materialization,
  registered the corrected H100 worker, admitted all four first-group
  multi-turn receipts with two distinct rewards, and committed optimizer step
  1. This live-proves the explicit input/output policy-transition contract; P0
  reached 1/16 groups with one applied update.
- 2026-09-02 22:42 UTC: Attempt 10 failed when a stale concurrent reconciliation
  replayed the committed first group and nondeterministic database row order
  changed the otherwise equivalent trajectory-set hash. The H100 pod remained
  healthy and was deliberately preserved.
- 2026-09-02 22:52 UTC: Canonicalized trajectory-set order and made identical
  existing training-step assembly a no-op while retaining strict rejection of
  real lineage changes. Sandbox revision `1aa5c4745` passed 311 Managed RL
  tests, typecheck, lint, CI, deployment-worker image publication, and the
  private staging control-plane canary. The Python worker image was unchanged,
  so the ready H100 remains eligible for attempt 11 reuse.
- 2026-09-02 23:12 UTC: Reconciled attempt 10 through a worker-local stop,
  unloaded its failed live adapter, released its training slot and allocation,
  and preserved the healthy physical H100 pod. Added warm compatible capacity
  to admission quotes and made terminal cleanup attest only after worker-local
  state is clean. Sandbox revision `fdf35b1c7` passed 313 Managed RL tests,
  typecheck, lint, CI, immutable image publication, and staging canary.
- 2026-09-02 23:20 UTC: Corrected reusable capacity stock to the provider quote
  contract in Sandbox revision `b6a95d2e2`, passed focused tests and typecheck,
  deployed image digest
  `d53b8b67b46eb475daab443bfd1cb5ff1a0fa77621a4e9254c45050c0570a91e`,
  and proved the live quote endpoint returns the existing H100 at $3.29/hour.
- 2026-09-02 23:23 UTC: Queued P0 attempt 11 as Model Run
  `model_run_632711dc-f4e9-4518-97e8-27c25418ba04` / managed job
  `zr50tldbd79spwyen7s65izp`. It reused physical worker
  `wxfaxsqqmygkqa5wgrrbd81o`, entered rollout phase without creating another
  GPU, and committed optimizer group 1/16 with one applied update.
- 2026-09-02 23:28 UTC: Attempt 11 committed its second optimizer transition
  from policy version 1 to 2. Its third rollout group then produced uniform
  reward `-0.05`, was consumed without an optimizer step, and the fourth group
  started from unchanged policy version 2. This live-proves contiguous lineage
  across an explicit no-signal skip.
- 2026-09-02 23:31 UTC: The first post-skip nonuniform group committed policy
  transition 2 to 3 and group 5 began from policy version 3. P0 is 4/16 groups
  consumed with three applied updates, one legitimate skip, and no terminal
  reason or lineage conflict.
- 2026-09-02 23:44 UTC: P0 completed all 16 groups with three applied updates
  and 13 explicit no-signal skips. OpenPond collected the verified 307,040,670
  byte rank-16 adapter and terminal receipt, published Model Version 57 as
  available, marked the P0 entry `candidate`, and launched no benchmark.
- 2026-09-02 23:48 UTC: Materialized P1 directly from predetermined correction
  task 20. Its parent is exactly P0 Model Version 57; the rank-16 P0 block is
  frozen, the new rank-1 block is trainable, and cumulative rank is 17. Started
  Model Run `model_run_38192149-6081-4a43-97a0-16fc223459b6` on the same H100.
- 2026-09-02 23:56 UTC: P1 persisted four nonuniform rollout receipts but a
  stale hosted-pool pass overwrote the local finalizer's `eligible` group state
  back to `running`. Added hosted/local ownership isolation plus receipt-backed
  recovery for the already-clobbered group. Sandbox revision `1d0157adb`
  passed 315 Managed RL tests, typecheck, lint, and targeted formatting; staging
  deployment is waiting on immutable CI publication. The P1 job and pod remain
  alive and have not been restarted.
- 2026-09-03 00:54 UTC: Paused before retrying P2 and audited P0/P1/P2. Confirmed
  that Run 57's third applied optimizer step reset from the initial trainable
  hash after a no-signal gap, invalidating its published adapter and downstream
  Run 58. Reconstructed the exact Qwen chat template and confirmed 4,096-token
  left truncation removed authentication and confirmation policy text on the
  first turn and the entire leading policy on longer turns. Added protected
  prompt compaction, a 7,168 + 1,024 context contract, latest-applied checkpoint
  resume, regression tests, and consistent training-run ordinals. Runs 57–59
  remain immutable superseded evidence; the next paid run restarts at P0.
