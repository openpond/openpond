# 2026-08-30 Enterprise Agent Scenario Packs and Continuous GRPO

Status: Portfolio index and shared architecture. The first pass builds four
low-cost, synthetic RLAIF examples. A later research pass expands the strongest
example with a larger evidence set and benchmarking.

Latest checkpoint: 2026-08-30. Build one cheap but complete example before
beginning the next. The default order is Commerce Support, Internal Operations,
Internal Knowledge, then Legal Contract Review. Every first-pass example uses
the OpenPond Harness, a domain Profile and Agent, deterministic evidence,
synthetic preference data labeled by an LLM judge, a frozen learned scorer, a
small Qwen Policy, one bounded GRPO Run, frozen evaluation, Agent-bound Chat,
one subsequent continual-learning Run, and a downloadable Profile Release.

Example working docs:

1. [Commerce Support Continuous RL](./2026-08-30-commerce-support-continuous-rl.md)
2. [Internal Operations Continuous RL](./2026-08-30-internal-operations-continuous-rl.md)
3. [Internal Knowledge Continuous RL](./2026-08-30-internal-knowledge-continuous-rl.md)
4. [Legal Contract Review Continuous RL](./2026-08-30-legal-contract-review-continuous-rl.md)

Related platform docs:

- [Model Project Protocol and Managed Training Control Plane](./2026-08-26-open-training-protocol-and-managed-control-plane.md)
- [Canonical Environment, Verifier, Reward, and RL Loop](./2026-08-17-canonical-environment-verifier-reward-and-rl-loop.md)
- [Harness Evaluation and Managed RL Review Loop](./2026-08-08-harness-evaluation-managed-rl-review-loop.md)
- [Sandbox Managed RL Reward Neutrality and Final Throughput Pass](../../../../sandbox/docs/working-docs/training/2026-08-30-managed-rl-reward-neutrality-and-final-throughput.md)
- [Portable Profile Releases](../profile/2026-08-30-portable-profile-releases.md)

## Portfolio Goal

The goal is not a benchmark gallery. It is four realistic proofs that a client
can define its work through an OpenPond Profile, train a Model inside the exact
Harness that performs that work, inspect the resulting Model in Chat, and
continually improve it from new evidence.

Each example must independently prove:

```text
Profile + Agent + Skills + tools + Environment
  -> complete trajectories and terminal artifacts
  -> deterministic reward components + synthetic-trained preference score
  -> one versioned scalar Reward Receipt
  -> one bounded GRPO candidate
  -> small untouched frozen evaluation
  -> Agent-bound Chat inspection
  -> second Dataset/Taskset release
  -> second Policy candidate from the retained demo parent
```

Do not start another example merely because the first example's code compiles.
The current example is complete only when its synthetic Reward Model, first
Policy candidate, frozen evaluation, Chat handoff, cost receipt, cleanup, and
second Week 1 candidate all execute with immutable evidence and the resulting
downloadable Profile installs and runs in a clean Profile library.

## Shared Product Decisions

### OpenPond Harness is the training runtime

Every rollout executes through the OpenPond Harness and its released Profile,
Agent, Skills, memory/context behavior, tools, policies, and Environment. Public
projects such as tau3-bench, ITBench, Doc2Dial, LegalBench, or Harvey LAB may
inform data or later benchmarking. Their harnesses do not replace OpenPond's
runtime.

### One domain Profile per example

The four Profiles are:

```text
commerce-support
operations-resolution
organization-assistant
contract-review
```

Each Profile owns one initial durable Agent. Skills contain focused procedures
and references; Agents own tools, actions, runtime state, fixtures, and evals.
Domain behavior belongs in Profile source and released data, never in
domain-specific Sandbox branches.

### One composed reward and one GRPO loop

An Attempt may have many reward components:

- deterministic terminal-state correctness;
- policy, approval, citation, and authorization evidence;
- tool-trajectory correctness and efficiency;
- human preferences or a learned scorer for subjective quality; and
- declared project-specific hard gates.

The Model Project's versioned reward composer reduces eligible components to
one finite scalar. One Policy Run uses one GRPO optimizer. Managed training
validates identity, schema, cardinality, finite outputs, budgets, and cleanup;
it does not decide whether the team's reward philosophy is good.

### Portfolio demo and research extension

Every example includes a learned scorer because the first pass should prove a
real RLAIF pipeline, not deterministic RLVR alone. Use deterministic evidence
where an outcome is objectively known and reserve the learned scorer for
quality that requires judgment.

The **portfolio demo track** uses original synthetic scenarios and 32-64
preference groups with two to four complete trajectories per group. A declared
LLM judge labels, ties, rejects, or abstains on those comparisons. The project
freezes a small train/development/evaluation split, trains a learned scorer,
records judge model/prompt/rubric/provenance, and reports held-out agreement and
reward-hacking probes. The evidence authority is `synthetic_rlaif`.

The **research extension track** begins only after all four demos complete and
one example is selected. That example may expand to hundreds of preference
groups, authorized human or expert review, double-review, stronger frozen
evaluation, more rollout groups, and an external benchmark adapter.

Scorer acceptance is Model Project evidence, never a Sandbox admission rule.
The scorer remains frozen throughout each Policy Run in both tracks.

### Shared low-cost demo recipe

Each first-pass example starts with this budgeted recipe unless a receipt-backed
preflight proves that a domain needs a larger bound:

| Item | Demo default |
| --- | --- |
| Policy and scorer base | Pinned `Qwen/Qwen3-0.6B` revision |
| Scenario clusters | 8 train, 2 development, 4 untouched frozen |
| Preference evidence | 32-64 synthetic groups, 2-4 candidates, LLM-judged |
| First Policy Run | 4 rollout groups x 4 siblings = 16 trajectories |
| Frozen comparison | 4 cases x 2 deterministic repeats for parent and candidate |
| Simulated Week 1 | New immutable evidence release plus a second 4 x 4 Run |
| LoRA | Rank 8 by default; increase only from measured evidence |
| Context and generation | Domain-specific bounded limits; no unbounded legal or retrieval context |

This is the smallest useful product proof, not a miniature acceptance gate that
must improve quality. It still produces two real LoRA Model Versions, two real
Training Jobs, receipts, cleanup, and visible lineage. If Qwen 0.6B cannot
produce a valid trajectory, record that result and make only the smallest
capability increase needed for that example.

### Chat is inspection; frozen evaluation is proof

The Model Project must let a user test base, accepted, and candidate Model
Versions through the exact Profile and Agent. Chat pins Profile, Agent, Skills,
Harness/environment, tools, Model Version, and optional Taskset task. Chat is
not substituted for frozen repeated evaluation.

### Continual learning is part of every example

After the first candidate, each example must create a second evidence window
and immutable Dataset/Taskset Release, reuse or update the frozen scorer, train
from the retained demo parent, and compare the new candidate against the same
frozen set. A flat candidate may be the demo parent when it passes hard
invariants; a candidate with a hard safety/policy regression may not, in which
case Week 1 starts from the base and records why the chained proof was not safe.
Scheduling may automate this workflow, but it may not silently change Profile
or reward identities.

## Shared Platform Prerequisite

Before the first Commerce Support paid proof, finish the authoritative Sandbox
correctness and throughput work needed for a trustworthy bounded Run:

- reward-neutral finite-score execution and zero-signal group semantics;
- declared GRPO normalization, shaping, fixed-reference KL, clipping, and
  update behavior;
- resident batched vLLM inference;
- resident Policy trainer, optimizer, and learned scorer;
- completion-only batched training;
- local hot activation plus asynchronous durable archival;
- stable-prefix caching and critical-path timing; and
- terminal GPU and Harness cleanup evidence.

Run one bounded infrastructure regression for changed Managed RL code. Then
proceed directly to the low-cost Commerce Support demo recipe. Do not run a
separate smoke job before the demo unless changed infrastructure lacks any
cheaper deterministic verification path.

### GPU and judge cost controls

The current RunPod contract already admits qualified 24 GB+ CUDA GPUs. Short
jobs use the general quote order; jobs with eight or more optimizer steps
deliberately prefer faster H100-class shapes. Add an explicit immutable
`portfolio_demo` resource profile so the first-pass recipe selects the lowest
**predicted total job cost** that passes memory/image/runtime preflight rather
than preferring 48 GB capacity or H100 by default. Record the chosen quote,
predicted duration, actual duration, and actual spend.

The profile must also:

- reuse the resident vLLM Policy, trainer, scorer, and persistent CPU lanes
  within each Job;
- cache the pinned base weights, tokenizer, image layers, compiled dependencies,
  and exact judge results by immutable content hash;
- batch sibling generation, scoring, and judge comparisons;
- use local hot activation and asynchronous artifact archival;
- cap context, completion tokens, turns, optimizer steps, wall time, and spend;
- preserve warm image/model caches between sequential portfolio Jobs when the
  provider safely supports it, without reusing mutable Job state; and
- terminate GPU and CPU resources at the terminal receipt.

Do not combine Week 0 and Week 1 into one mutable Job merely to save a cold
start. A future campaign-affinity feature may place separate immutable Jobs on
the same warm worker, but only with independent inputs, outputs, budgets,
receipts, and cleanup authority.

### Minimum product changes required for the four demos

Keep every change generic and reusable across the four Profiles:

1. **Trace-conditioned reward input:** finish the generic bounded trajectory
   serializer in `@openpond/contracts`; the current Duck candidate-JSON
   processor is not enough for conversations, tools, state, citations, or
   artifacts.
2. **Synthetic judge evidence:** represent an LLM judgment as a versioned
   preference-evidence authority with model/prompt/rubric identity, structured
   result, uncertainty/abstention, token usage, cost, and source trajectory
   hashes. Do not overload a `human` evidence type.
3. **Reward Model workflow:** let a Model Project assemble synthetic preference
   groups, freeze their partitions, train a small scorer, inspect held-out
   agreement/probes, and pin the resulting Reward Model Version into Training.
4. **Complete Model Project identity:** make Profile, Agent, Skill,
   Environment, Dataset/Taskset, Reward Model, composer, Policy parent, and
   recipe visible and immutable across Run submission, lineage, and Chat
   handoff.
5. **Generic scenario authoring:** add reusable fixture/reset, hidden-objective,
   tool-capability, artifact, and deterministic-verifier helpers. The four
   examples contribute data and Profile assets, not platform-specific APIs.
6. **Low-cost execution profile:** add the `portfolio_demo` recipe/resource
   profile, predicted-total-cost quote selection, cost/timing receipts, and hard
   budget caps. Preserve a caller override for a measured-capable larger shape.
7. **Two-Run comparison:** display parent -> Candidate 1 -> Candidate 2,
   Dataset/Taskset Release 1 -> 2, Reward Model identity, frozen comparison,
   and spend/cleanup receipts without requiring recurring scheduler work.
8. **Portable Profile Release:** export the complete Profile, Agents, Skills,
   resources, Tasksets, evals, and recipe as a pinned Git release and
   `.openpond-profile.zip`; install it into a clean library, pass readiness
   checks, and open it in Chat/Work.

All four examples use these same generic product surfaces.

### Portfolio cost envelope

Planning caps, excluding engineering time:

| Example | Two Policy Runs, scorer, judge, and tiny evaluation |
| --- | ---: |
| Commerce Support | `$4-$20` |
| Internal Operations | `$5-$25` |
| Internal Knowledge | `$5-$30` |
| Legal Contract Review | `$10-$40` |
| Four-demo portfolio | `$24-$115` |

The target should move toward the low end after resident batching and cache
work. Cold-start retries, long judge inputs, or a required larger Qwen/GPU move
an example toward the high end. Exact Job and judge receipts replace these
planning caps. If a job's quote cannot fit its cap, stop before launch and
shrink context/evidence or explicitly revise the plan; do not silently spend a
research-sized budget.

## Generic UI and API Contract

Core product resources remain generic:

```text
Model Projects
Profiles and Profile Releases
Agents and Agent Releases
Skills and Skill Releases
Datasets and Taskset Releases
Reward Models and reward composers
Training Jobs and Model Versions
Agent Runs and traces
Continual-learning schedules
```

The common UI needs Dataset, Reward, Training, Agent-bound Chat, trace, and
schedule/history views. The examples populate these screens with different
Profile assets. Do not add `/customer-support`, `/legal`, or equivalent domain
resource APIs.

Hugging Face is an optional exact-revision Dataset source and later public
export adapter. It is not the weekly learning control plane. Private customer
evidence remains team-scoped OpenPond data.

## Shared Week Simulation and Publication Contract

Every example must visibly simulate one week of learning:

```text
Week 0
  -> build full Profile, Dataset, scorer, and parent baseline
  -> train Candidate 1
  -> frozen evaluation and Agent-bound Chat
  -> designate Candidate 1 as the demo parent if hard invariants pass;
     otherwise retain the base

Simulated Week 1
  -> introduce a domain-specific new evidence window
  -> publish Dataset/Taskset Release 2 with historical replay
  -> reuse or update and freeze the scorer
  -> train Candidate 2 from the retained demo parent
  -> repeat frozen evaluation and Chat comparison
  -> show Model lineage and changed weights
```

The simulation uses real immutable releases and two real Training Jobs. It may
compress a calendar week into one test session, but the UI, API, lineage,
receipts, weights, and scheduler behavior must be the same as a real weekly
cycle.

After each example executes end to end, create two public research drafts under
`docs/research/`:

1. **Case-study blog:** problem, Agent, before/after story, Week 0 and Week 1,
   results, costs, what a client can build next, and a direct Profile
   download.
2. **Technical how-to:** exact Profile/Agent/Skill setup, Dataset and preference
   construction, reward recipe, training configuration, UI steps, metrics,
   receipts, Profile installation, reproduction instructions, and
   implementation details.

Capture screenshots from the real UI while the evidence exists. Raw run
evidence belongs under
`docs/working-docs/training/assets/<example>/<run-or-release-id>/`; publication-
safe copies belong under `docs/research/assets/<dated-example>/`. At minimum,
capture:

- Model Project overview and selected Profile/Agent/Skills;
- Dataset/Taskset Release 1 and Reward Model evidence;
- first Run progress, reward components, KL, metrics, and completion;
- Candidate 1 lineage and Agent-bound Chat;
- Week 1 evidence and Dataset/Taskset Release 2;
- second Run and Candidate 2 lineage;
- parent-versus-candidate frozen comparison; and
- spend, artifact, and cleanup receipts with public-safe identifiers.

Screenshots and articles must be reviewed for secrets, tokens, local paths,
private traces, unrelated sidebar history, and protected client material. Use
the completed Runs and installed Profile for every screenshot.

## Execution Order

### Current - Commerce Support

Complete the linked Commerce Support low-cost demo, including its first
candidate and continual-learning candidate. Do not begin implementation of the
other three Profiles while it is active.

### Next - Internal Operations

Begin only after Commerce Support has no domain-specific platform exceptions
and its full proof is recorded.

### Then - Internal Knowledge

Begin after Operations. Preserve the boundary between changing retrieved facts
and Policy behavior learned through RL.

### Last - Legal Contract Review

Begin after the first three examples. Keep matters short enough for the demo
Qwen/context profile. External legal benchmarks are optional research-extension
adapters, not prerequisites.

### After all four - select one research extension

Choose one example using completed receipts and evidence: valid trajectory
rate, scorer learnability, reward variance, observable parent/candidate change,
domain credibility, evaluation clarity, runtime, and cost. Only that example
expands to a human-reviewed Reward Model, research-sized GRPO Run, stronger
frozen trials, and a relevant external benchmark. Do not choose based only on
the largest reward delta from the tiny demo.

## Portfolio Boundaries

- Do not implement multiple examples in parallel.
- Do not adopt an external benchmark harness as the training runtime.
- Do not train on a benchmark task and report it as untouched evaluation.
- Do not make Chat the acceptance gate.
- Do not update a Reward Model during a Policy optimizer Run.
- Do not let learned reward compensate for unauthorized or unsafe mutations.
- Do not add domain-specific API or Sandbox resource types.
- Do not build website deployment, automatic production promotion, or public
  dataset publication as part of these four training proofs.
- Do not spend human-review hours on all four first-pass examples.

## Portfolio Validation

- Passed: the current contracts already represent stateful Tasksets, multiple
  grader kinds, one composed Reward Receipt, one Policy optimizer binding, and
  immutable Model Versions.
- Passed: one Duck systems Run proved the short end-to-end Harness, learned
  scorer, GRPO, LoRA, cleanup, and receipt path.
- Passed: four independent end-to-end example working docs now define their
  Profiles, Agents, Skills, data, reward, bounded GRPO, Chat, costs, and
  continual learning.
- Pending: Sandbox protocol/throughput acceptance.
- Pending: implementation and proof of every example; Commerce Support is first.
- Pending: lowest-total-cost GPU admission profile, measured demo baseline, and
  Portable Profile Release implementation.
- Skipped: no dataset import, new paid Run, or external benchmark execution was
  performed while splitting this plan.

## Progress Log

- 2026-08-30: Split execution into four cheap synthetic-RLAIF demos followed by
  one selected human-reviewed research extension. Standardized the 8/2/4,
  32-64 preference-group, two 4x4 Run recipe, cost-aware GPU/judge controls,
  and a downloadable Profile deliverable.
- 2026-08-30: Added the shared Week 0/Week 1 simulation, hybrid synthetic-plus-
  human evidence policy, publication-safe screenshot contract, and two-blog
  completion requirement for every example.
- 2026-08-30: Split the original broad scenario-pack plan into this shared
  portfolio index plus four independent end-to-end example docs. Restored the
  intended objective: full real-world Reward Model and GRPO proof followed by
  continual learning, using the OpenPond Harness exclusively.
