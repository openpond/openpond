# 2026-09-01 Continual Support Causal Rank Sweep

Status: Correctness repairs are deployed and the replacement causal P0–P8
protocol is sealed. No result from Retail Support Version 2 is valid evidence
for this study. Fresh P0 is active on staging; P1–P8 remain queued behind its
published seed artifact.

Latest checkpoint: 2026-09-03 04:24 UTC. Sandbox commits `73c0ddabc` and
`2bc992881`, plus deployment pin `72cffde84`, passed the complete CI-shaped
source suite and Source Validation. Staging pins corrected worker image
`sha256:c9e7a12d5958bcb744e460c054b9fdb129a38954eec2dff58c959876822d8abc`.
Retail Support Version 3 project `retail-support-version-3` and sealed series
`retail-support-version-3-causal-rank` use protocol hash
`29d02a95c20fb298b1173824dab663ed9714ba85bfe807b27b809f77ba15a3ca`.
Fresh P0 Model Run `model_run_2ca6809b-d6a3-43e3-9343-077e19e17a06` is
admitted on one H100. The exact immutable image has downloaded and container
startup is in progress; optimization has not begun, so no result is claimed.

Product name: **Continual Support**. Create the corrected execution as a new
Model Project, **Retail Support Version 3**, with one sealed Comparison Series.
Tau Retail remains user-owned Taskset, environment, grader, and fixture data;
none of it belongs in generic OpenPond or Sandbox source.

Related working docs:

- `2026-09-02-daily-evals-intake-and-nightly-learning.md` owns optional Evals
  intake and review.
- `2026-09-01-commerce-support-production-grader-and-comparisons.md` owns the
  user-supplied deterministic retail grader.
- `2026-09-01-model-comparison-human-review-ui-cleanup.md` owns the Models and
  Evals information architecture.

## Outcome

Determine whether increasing the rank of one new residual LoRA block improves
learning when every other controlled input is held fixed.

P0 produces one shared rank-16 seed Model Version. P1–P8 are independent sibling
arms. Every sibling starts from that exact P0 artifact, trains on the exact same
sealed Taskset release, and uses the same seeds, rollout topology, learning rate,
optimizer, number of optimizer groups, optimizer iterations, KL coefficient,
clipping, target modules, and evaluation matrix. The only intended independent
variable across P1–P8 is child rank.

This is not a cumulative daily-learning claim. The Evals inbox remains a valid
way to collect and review future tasks, but browser review is not an execution
gate for this predetermined causal study.

## Current product boundaries

| Surface | Responsibility |
| --- | --- |
| Model Comparisons | Sealed study schedule, exact lineage, run status, benchmark matrix, and final rank comparison |
| Evaluations | Raw evaluation runs, attempts, transcripts, traces, receipts, and failures |
| Evals | Optional task intake, generated or imported responses, oracle inspection, human correction, and queueing |

The sweep runs through canonical Comparison Series and Model Run services. It
does not require manual Evals clicks, a production deployment, or promotion.

## Controlled training graph

| Pass | Exact parent | Child rank | Enabled rank | Training release |
| --- | --- | ---: | ---: | --- |
| P0 | frozen Qwen base | 16 | 16 | sealed seed Taskset |
| P1 | exact P0 Model Version | 1 | 17 | shared sealed rank-study Taskset |
| P2 | exact P0 Model Version | 2 | 18 | shared sealed rank-study Taskset |
| P3 | exact P0 Model Version | 3 | 19 | shared sealed rank-study Taskset |
| P4 | exact P0 Model Version | 4 | 20 | shared sealed rank-study Taskset |
| P5 | exact P0 Model Version | 6 | 22 | shared sealed rank-study Taskset |
| P6 | exact P0 Model Version | 8 | 24 | shared sealed rank-study Taskset |
| P7 | exact P0 Model Version | 11 | 27 | shared sealed rank-study Taskset |
| P8 | exact P0 Model Version | 16 | 32 | shared sealed rank-study Taskset |

The P1–P8 arms may run in protocol order, but they do not inherit from one
another. Admission must fail if P0 lacks a published Model Version or if any arm
resolves a different parent or Taskset hash.

P0 and P1–P8 have separate purposes:

- P0 establishes the common seed behavior.
- P1–P8 estimate the effect of child rank under a shared continuation problem.
- P1–P8 are the causal rank comparison. P0 is the common-parent baseline, not a
  ninth child-rank treatment.

## Fixed optimization contract

- LoRA effective scale is fixed at `alpha / rank = 2`; raw alpha is `2 × rank`.
- AdamW is explicit and hashed: `weight_decay = 0`, `beta1 = 0.9`,
  `beta2 = 0.999`, and `epsilon = 1e-8`.
- Learning rate, target modules, dropout, clipping, rollout seeds, temperature,
  top-p, group size, optimizer iterations, and group count are identical across
  P1–P8.
- The plan records both optimizer groups and actual Adam steps. Maximum Adam
  steps equal `optimizer groups × optimizer iterations`.
- One optimizer iteration consumes the entire trajectory group and performs one
  Adam step. Turn count must never multiply optimizer steps.
- Every trajectory has equal total loss weight. A trajectory with more turns
  does not receive more influence; its weight is divided across its turns.
- Valid batches contain 2–32 trajectories and up to 256 turns per trajectory.
  The TypeScript and Python boundaries must admit and reject the same domain.
- The declared seed is applied before base-model and PEFT adapter construction,
  including random LoRA A initialization.
- P0 applies KL against the frozen base. P1–P8 apply KL against the exact
  incoming P0 parent. Base-relative KL remains diagnostic for every arm.
- `klBeta = 0.01` is fixed for this sweep.
- A zero-variance reward group has zero normalized policy advantage and therefore
  no meaningful policy gradient. It is recorded as a no-signal group and does
  not create a fake Adam step. The run still preserves its valid checkpoint and
  continues to later groups.

Before launch, seal one exact optimizer-group count per task for every P1–P8
arm. The count must be large enough to provide repeated reward-bearing groups
but keep each paid run within the one-hour cap. Do not change it by rank after
the protocol is sealed.

## Required worker evidence

Every successful training step must record:

- declared optimizer iterations and actual Adam steps;
- trajectory count, turn count, and equal-trajectory weighting;
- initialization seed and complete AdamW configuration;
- gradient-checkpointing enabled and active-during-update flags;
- parameter hashes before and after each applied update;
- behavior-policy KL, applied parent-relative KL, and diagnostic base-relative
  KL;
- per-residual-block `||BA||F` and leading singular values;
- LoRA-to-base projection activation-ratio summary; and
- serialized composite behavior equivalence after loading through the PEFT
  serving path, including maximum absolute log-probability delta and tolerance.

Factor-slice persistence alone is not a behavior equivalence proof. Artifact
publication is evidence preservation, so a failed probe or trainer-contract
mismatch is recorded rather than discarded. A nonconforming Model Version is
ineligible for the causal rank claim and automatic advancement until rerun; only
corrupt/unloadable artifact bytes or broken immutable lineage block publication.

## Task and reward contract

Each training task provides the user request, initial environment state, tool
schemas, expected final-state contract, privileged grader configuration, grader
fixtures, provenance, and immutable task/environment/grader hashes.

The Taskset need not contain a prerecorded Qwen response. For every rollout the
current policy receives one static task and generates a fresh on-policy
trajectory. The user-supplied deterministic grader inspects the trace and final
state and returns the scalar reward used by GRPO. Required reads, confirmation
checks, tool errors, and database-state checks belong to that grader release,
not generic application code.

## Evaluation design

Automatic evaluation remains gated until P0–P8 all publish exact Model Versions.
Then run the same sealed panels, seeds, and repetitions for every candidate.

The final scorecard must include:

- P1–P8 performance on the shared rank-study task release;
- shared sibling, development, retained, and frozen-final panels;
- paired deltas from the exact P0 parent;
- pairwise rank-arm comparisons and confidence intervals;
- fixed, regressed, unresolved, and infrastructure-failed task IDs;
- parent-relative and base-relative KL;
- realized block norms, singular values, activation ratios, Adam steps, latency,
  tokens, GPU time, and spend; and
- links to immutable raw evaluation evidence.

Do not claim that rank caused an improvement unless the compared arms share the
same parent, task hash, recipe hash except rank/alpha, evaluation protocol, and
successful infrastructure status.

## Execution plan

### Phase 0 — Correctness repair

- [x] Cancel the invalid Version 2 P0 before further paid optimization.
- [x] Prevent stale worker projection from overwriting a newer inference state.
- [x] Preserve trajectory and turn identity across the training boundary.
- [x] Weight trajectories equally and take exactly one Adam step per optimizer
  iteration over the complete group.
- [x] Align admitted multi-turn bounds across TypeScript and Python.
- [x] Seed before PEFT initialization.
- [x] Pin and hash the complete AdamW recipe.
- [x] Budget actual Adam steps, not only optimizer groups.
- [x] Apply child KL against the exact immutable parent and retain base KL as a
  diagnostic.
- [x] Record whether gradient checkpointing is active during optimization.
- [x] Record block norms, singular values, and activation ratios.
- [x] Replace the factor-only reload assertion with a behavior-equivalence probe
  and preserve nonconforming artifacts with explicit evidence.
- [x] Pass the complete Sandbox worker suite in the packaged worker image. Done:
  91 worker tests pass without skips in the packaged environment.
- [x] Pass broader Sandbox and OpenPond CI from the exact commits to deploy.
  Done: 62 source shards, three isolated runtime suites, and the focused
  OpenPond continual-support suite pass; Source Validation is green.

### Phase 1 — Seal Retail Support Version 3

- [x] Publish the corrected immutable worker image and recycle the old idle H100.
- [x] Create one new Retail Support Version 3 Model Project and one Comparison
  Series; do not mutate or reuse sealed Version 2 evidence.
- [x] Seal P0 plus eight `rank_candidate` siblings using the graph above.
- [x] Verify every P1–P8 protocol entry uses `seed_release`,
  `eligible_task_pool`, a distinct child rank, and the exact same non-rank
  training settings.
- [x] Verify Tau artifacts resolve only from user-owned data and R2 objects.
- [x] Verify no automatic evaluation starts before all nine Model Versions exist.

### Phase 2 — Train and prove P0

- [x] Queue P0 from the frozen base and sealed seed Taskset.
- [x] Verify the admitted recipe, actual Adam-step budget, and one-hour cap.
  Done: rank 16, 16 optimizer groups, two optimizer iterations, at most 32
  actual Adam steps, and an external one-hour paid-runtime cutoff are active.
- [x] Start P0 through the canonical Model Run path.
- [ ] Require live evidence for deterministic initialization, trajectory-level
  optimizer accounting, active checkpointing, real serialization equivalence,
  and a continuous applied-update parameter-hash chain.
- [ ] Publish the rank-16 P0 Model Version.

### Phase 3 — Train P1–P8 causal siblings

For every arm:

- [ ] Resolve the exact same P0 Model Version and shared Taskset hash.
- [ ] Freeze the P0 block and train only the declared child block.
- [ ] Verify `alpha / rank = 2` and an otherwise identical recipe hash.
- [ ] Stop and diagnose if a paid arm reaches one hour without a terminal state.
- [ ] Publish a distinct Model Version with complete worker evidence.
- [ ] Confirm no benchmark evaluation has started early.

### Phase 4 — Evaluate and report

- [ ] Reconcile the sealed matrix after all nine Model Versions exist.
- [ ] Complete paired P0-versus-child evaluation for every P1–P8 arm.
- [ ] Complete shared retained, development, sibling, and frozen-final panels.
- [ ] Run external references only after the candidate matrix is terminal.
- [ ] Produce the causal rank scorecard with uncertainty and infrastructure
  failures separated from model-quality failures.
- [ ] Preserve all series, protocol, Model Version, Evaluation, and artifact
  identities. Do not promote to production from this plan.

## Validation commands

Before publishing the worker:

```bash
cd /home/glu/Projects/all/sandbox
python -m py_compile managed-rl-worker/policy_trainer.py managed-rl-worker/worker.py
python -m unittest managed-rl-worker/test_policy_trainer.py
pnpm exec tsc --noEmit --pretty false
bun test lib/sandbox/managed-rl deployment-worker/domain/services/managed-rl
```

Before pushing the OpenPond PR:

```bash
cd /home/glu/Projects/all/openpond
pnpm --filter @openpond/continual-support build
pnpm --filter @openpond/contracts build
pnpm typecheck
pnpm exec vitest run \
  apps/server/src/training/comparison-series-training-recipe.test.ts \
  apps/server/src/training/model-comparison-series-service.test.ts \
  apps/server/src/training/model-comparison-evaluation-scheduler.test.ts \
  apps/server/src/training/model-currency-projection-service.test.ts \
  tests/continual-support-contracts.test.ts \
  tests/continual-support-package.test.ts \
  tests/learned-preference-training-contracts.test.ts
```

## Invalidated evidence

Retail Support Version 2 and Runs 57–59 remain immutable diagnostics only. They
cannot support the causal rank claim because they used cumulative/different
parents and task releases. Earlier Version 2 attempts also exposed prompt
truncation, checkpoint-resume, trajectory-order, worker-state projection, and
trainer-accounting defects. Those records must remain visible as failed or
superseded evidence, but none may be reused as P0 or as a parent for Version 3.

## Deferred work

- Publish a compact serving derivative at enabled rank while retaining the
  rank-32 continuation envelope as the canonical training artifact.
- Run a separate alpha-scale ablation if needed. Alpha is not a live toggle in
  this study.
- Return to real continual intake after the causal rank mechanism is validated;
  that future study may use sequential daily parents and newly reviewed tasks.

## Unresolved before sealing

- Pin the shared P1–P8 optimizer-group count per task after a bounded live timing
  proof on the corrected worker. It must be identical across ranks.
- Confirm the serialized behavior tolerance (`5e-4` maximum absolute completion
  log-probability delta) on the real Qwen worker. Tighten it if live numerical
  behavior is materially better; never loosen it after the protocol is sealed.
