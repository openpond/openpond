# 2026-08-30 LAB Contract Review Continuous RL

Status: Active flagship execution. Phases 0 through 2 are implemented and the
Qwen3-8B worker image is building for the first paid Week 0 preflight.

Latest checkpoint: 2026-08-30. Legal is now the only active enterprise example.
Pin Harvey LAB at commit `a2b429eb6c9683c4fdeced3bc6b3af36edf239a6`
(MIT), adapt its public contract-review matters into an OpenPond Work Taskset,
and run the Policy entirely through the OpenPond Harness. Week 0 uses six Master
Services Agreement counterparty-paper-review scenarios; Week 1 uses five SaaS
and API Subscription counterparty-paper-review scenarios. The hosted Managed RL
runner now carries exact Work assets, executes a multi-turn tool loop on
persistent resettable Latitude CPU lanes, seals output artifacts, retains
per-turn Policy samples, and applies the user-declared rubric reward. The Week 0
release is separately materialized so the first Run cannot observe Week 1
tasks. No GPU Run has been launched for this example yet.

Related docs:

- [Enterprise examples](./2026-08-30-enterprise-agent-scenario-packs-and-continuous-grpo.md)
- [Managed control plane](./2026-08-26-open-training-protocol-and-managed-control-plane.md)
- [Portable Profile Releases](../profile/2026-08-30-portable-profile-releases.md)
- [Harvey LAB repository](https://github.com/harveyai/harvey-labs)
- [LAB evaluation methodology](https://github.com/harveyai/harvey-labs/blob/a2b429eb6c9683c4fdeced3bc6b3af36edf239a6/docs/eval-strategies.md)
- [Harvey open-model post-training](https://www.harvey.ai/blog/post-training-open-legal-agents-with-baseten-research)

## Outcome

Prove one externally legible legal learning loop:

1. import a pinned public LAB task family into an immutable OpenPond Taskset;
2. execute complete document-review episodes inside the OpenPond Harness;
3. grade the produced work product against LAB rubric criteria;
4. compare the untrained base Policy and a 16-group GRPO LoRA on a frozen
   matter;
5. reveal a Week 1 task release, update the retained LoRA, and evaluate both
   Week 0 retention and Week 1 adaptation; and
6. ship the Agent, Skills, task adapter, model lineage, receipts, and examples
   as an installable `contract-review` Profile Release.

The first publishable result is a precise cost-quality statement on the pinned
public subset. An official Harvey holdout or leaderboard result remains a
separate external submission because Harvey's published headline results use a
non-public holdout.

## Product Decision

- Run this example before Commerce Support, Internal Operations, or Internal
  Knowledge. Those examples remain queued until the legal loop exposes the
  reusable platform gaps.
- Use Harvey LAB data, matter files, and rubrics; do not use Harvey's Harness.
- Keep legal behavior in Profile, Skills, Taskset data, and grader releases.
  Add no legal-specific API or infrastructure resource types.
- Use LAB's criterion rubric and a declared LLM judge as the first reward
  source. Do not require a separately trained Reward Model before the first
  Policy Run. Judgments may later be distilled into a cheaper scorer.
- Preserve every rubric criterion as hidden grader context. The Policy receives
  the partner instruction, matter files, Skills, tools, and prior tool results,
  never the rubric or expected findings.
- Use Qwen3-8B as the first credible supported Policy target, subject to the
  worker image and one-task memory/runtime preflight. Qwen3-0.6B remains an
  infrastructure fixture and is not the legal candidate.
- Keep the initial learning protocol synchronous and on-policy. A trajectory
  may contain many Policy turns; each Policy turn contributes its own masked
  training sample with the trajectory-level advantage.
- Use the official LAB dual-judge profile for final comparison when available:
  Claude Sonnet 4.6 plus GPT-5.5, scored independently and averaged. A cheaper
  declared judge may drive training only after agreement is measured on the
  development matter.
- Do not tune against either frozen matter. Week 1 training data becomes visible
  only after the Week 0 candidate and evaluation artifacts are sealed.

## Pinned Data

Source repository: `harveyai/harvey-labs`

Pinned commit: `a2b429eb6c9683c4fdeced3bc6b3af36edf239a6`

License: MIT

### Week 0: Master Services Agreement review

Source family:

`tasks/contracts/commercial-vendor-customer/master-services-agreement-counterparty-paper-review`

| LAB scenario | OpenPond split | Purpose |
| --- | --- | --- |
| `scenario-01` through `scenario-04` | `train` | GRPO prompts and matter files |
| `scenario-05` | `validation` | judge agreement, recipe, and failure analysis |
| `scenario-06` | `frozen_eval` | sealed Week 0 comparison |

Each scenario asks the Agent to review counterparty paper against the supplied
playbook and standard form, produce a redline DOCX, and produce an issues/risk
memo DOCX. The exact filenames come from the pinned task instructions and are
declared as required outputs in the OpenPond Taskset.

### Week 1: SaaS and API Subscription review

Source family:

`tasks/contracts/commercial-vendor-customer/saas-api-subscription-counterparty-paper-review`

| LAB scenario | OpenPond split | Purpose |
| --- | --- | --- |
| `scenario-01` through `scenario-03` | `train` | newly revealed Week 1 adaptation data |
| `scenario-04` | `validation` | Week 1 recipe and judge analysis |
| `scenario-05` | `frozen_eval` | sealed Week 1 comparison |

The Week 0 frozen matter remains an anchor after Week 1. Candidate 2 is accepted
only from the joint Week 0 retention and Week 1 frozen evidence.

## OpenPond Profile

Profile: `contract-review`

Agent: `contract-review`

Skills:

- `matter-intake`: inspect the instruction and inventory the complete matter;
- `document-review`: read and search relevant agreements, exhibits, emails,
  spreadsheets, playbooks, and standard forms;
- `playbook-analysis`: identify deviations, required positions, fallbacks,
  escalation thresholds, and financial exposure;
- `redline-production`: create a document-native tracked-change deliverable;
- `risk-memo`: produce an issue-complete, prioritized, cited review memo;
- `self-review`: validate filenames, issue coverage, calculations, grounding,
  and consistency before submission; and
- `attorney-handoff`: identify unresolved judgment calls and submit reviewable
  artifacts without external delivery.

The default Work tools remain generic: capability/readiness inspection, file
listing and reading, bounded execution, writing/editing, output saving, and
termination. Document utilities and bundled Python libraries may support DOCX,
EML, and XLSX inspection and DOCX output, but those are runtime capabilities,
not legal APIs.

## Required Managed RL Extension

The current hosted runner is intentionally compact and single-turn. LAB requires
the following general Work trajectory contract before a legal Run can start.

### Work task transport

- carry immutable task assets and required-output declarations from the
  resolved OpenPond Taskset bundle into the Managed RL environment package;
- materialize each matter into `/workspace/inputs` on a persistent but resettable
  Latitude lane;
- give each rollout a fresh `/workspace/work` and `/workspace/outputs` state;
- verify asset bytes, filenames, media types, source commit, and task split; and
- retain only immutable output artifacts and trace evidence after reset.

### Multi-turn Harness execution

- run the Policy/tool loop inside the OpenPond Harness rather than making one
  completion request;
- send OpenAI-compatible tool schemas through the existing Policy gateway;
- execute bounded file and shell tools locally in the CPU sandbox;
- support compaction or bounded continuation before the Policy context limit;
- stop only after required outputs are saved or a declared terminal limit is
  reached; and
- record the complete tool sequence, messages, token usage, latency, failures,
  and artifact inventory.

### Multi-window training evidence

- preserve every Policy request's exact token IDs, completion mask, behavior
  logprobs, temperature, Policy Version, and request ID;
- represent one trajectory as one or more independently bounded Policy samples;
- broadcast the trajectory-level GRPO advantage to every eligible assistant
  token across those samples;
- keep tool results and prompts non-trainable;
- reject cross-version, missing-turn, over-limit, or non-durable samples; and
- report turns, samples, trainable tokens, and compaction events separately.

### Artifact rubric reward

- upload required outputs to immutable job storage before scoring;
- scope each rubric criterion to the relevant deliverable bytes or normalized
  rendered text;
- invoke the declared judge without exposing criteria to the Policy;
- preserve one verdict and rationale per criterion and judge;
- produce criterion-pass fraction and strict all-pass; and
- feed the declared scalar reward to GRPO without platform-authored legal
  quality gates or hidden shaping.

## Model Profile

Target: `Qwen/Qwen3-8B`, pinned to an immutable Hugging Face revision and
complete local model lock before image qualification.

The worker release must:

- support the selected Qwen architecture in both vLLM and Transformers/PEFT;
- verify config, tokenizer, chat template, and every allowed model file;
- run tool calling with the pinned parser/template;
- admit an H100-class GPU with measured inference and trainer headroom;
- use rank-16 LoRA initially, with all target modules declared;
- support at least one bounded Work turn sample without silent truncation; and
- publish a distinct model/worker profile rather than mutating the 0.6B lock.

The first one-task preflight determines the largest safe per-turn context and
output bounds. The Taskset must compact or continue between bounded windows; it
must not silently truncate matter evidence or assistant targets.

## Reward and Evaluation

For each trajectory, calculate:

- pooled criterion pass rate;
- strict all-pass;
- required artifact completeness and validity;
- grounding and citation support;
- issue/deviation coverage;
- severity, fallback, and playbook alignment;
- calculation correctness;
- unsupported finding and false-positive rate;
- document coverage and tool behavior; and
- turns, tokens, latency, judge cost, GPU cost, and total cost.

Training reward is the declared rubric score for that exact Task release and
judge release. Optional efficiency shaping must be explicitly named and
versioned; the first comparison uses no hidden length or turn penalty.

Final evaluation runs both base and candidate artifacts through the same pinned
dual-judge profile. Preserve per-judge results, disagreements, pooled criterion
pass, strict both-judge all-pass, and bootstrap intervals where the sample count
supports them.

## Run Plan

### Week 0 base and Candidate 1

- Baseline the untrained Qwen3-8B Policy on MSA `scenario-05` and sealed
  `scenario-06` through the complete Work Harness.
- Run one real-task paid preflight on a training matter after all local and
  staging contract tests pass. This validates the exact final task/model/reward
  shape; it is not an exact-text smoke.
- Launch 16 rollout groups with four sibling trajectories per group, cycling
  deterministically across MSA `scenario-01` through `scenario-04`.
- Evaluate Candidate 1 once on `scenario-05` and sealed `scenario-06`.
- Preserve the LoRA and receipts whether the quality result improves or not.

### Week 1 Candidate 2

- Reveal SaaS `scenario-01` through `scenario-03` only after Candidate 1 and
  Week 0 evaluation are immutable.
- Use SaaS `scenario-04` for development and keep `scenario-05` sealed.
- Train Candidate 2 from the retained Candidate 1 parent with the same declared
  protocol unless development evidence selects a versioned change.
- Evaluate Candidate 2 on both MSA `scenario-06` and SaaS `scenario-05`.
- Report Week 1 gain, Week 0 retention/forgetting, incremental spend, and
  complete lineage.

## Cost Envelope

The legal Run is materially heavier than the completed Duck NFT run because
each rollout contains multiple Policy turns, document processing, artifact
generation, and rubric judging. Before launch, admission must quote and bind:

- maximum GPU duration and spend;
- maximum CPU-lane duration and spend;
- maximum Policy turns and tokens per trajectory;
- maximum judge calls and spend;
- maximum artifact bytes; and
- teardown deadlines for every paid resource.

The first target is the lowest total-cost H100 configuration that safely hosts
Qwen3-8B. Do not select a cheaper GPU that increases total cost through repeated
loading, context failure, or rollout retries.

## Phases

### Phase 0 — Pin the flagship and audit the real execution gap

- [x] Select Legal as the only active enterprise example. Done: the other three
  example specs remain queued and receive no implementation work.
- [x] Pin LAB source, license, Week 0 family, and Week 1 family. Done: commit,
  exact task paths, split ownership, and official evaluator are recorded above.
- [x] Audit the hosted Managed RL Harness boundary. Done: the current Latitude
  script performs one Policy call and carries neither Work assets nor outputs.
- [x] Audit the Policy gateway and worker. Done: tool schemas and turn indices
  already exist, but the trajectory and trainer retain only one Policy sample.
- [x] Select the first credible Policy class. Done: Qwen3-8B replaces 0.6B for
  the legal candidate, subject to image qualification and real-task preflight.

### Phase 1 — Materialize the pinned LAB Taskset and Profile

- [x] Add a pinned LAB import/materialization command with hash and license
  verification for the selected eleven scenarios only. Done: the importer pins
  commit `a2b429e…` and emits the complete ledger or isolated Week 0 release.
- [x] Create the immutable Work Taskset, source records, asset manifests,
  required outputs, hidden rubric releases, and Week 0/Week 1 split ledger.
- [ ] Implement the `contract-review` Profile, Agent, Skills, and reusable
  document runtime guidance.
- [x] Validate every task, asset byte, output declaration, policy boundary,
  source commit, and split-isolation rule. Done: Week 0 is six tasks and 53
  assets at Taskset hash `9ef434ddaf456c1641a230038f2f2a4a79f44fcf658d79eb1ec8d65b2bc5c8c6`.

### Phase 2 — Execute full Work trajectories in hosted Managed RL

- [x] Extend the portable/internal Managed RL contract for Work assets,
  required outputs, and hidden rubric references.
- [x] Replace the single-call hosted script with the generic multi-turn Work
  loop using the existing Policy gateway and persistent resettable CPU lane.
- [x] Persist and verify output artifacts before sandbox reset.
- [x] Extend trajectory and trainer contracts from one sample to multiple
  bounded Policy samples per rollout.
- [x] Add unit, integration, failure, retry, reset, isolation, and receipt tests.
  Done: the managed suite passes 253 tests and both product typechecks pass.

### Phase 3 — Add rubric reward and Qwen3-8B

- [x] Add the generic artifact-rubric judge reward source and exact evidence
  schema; keep quality qualification optional and external to admission.
- [ ] Add, lock, build, and qualify a distinct Qwen3-8B worker/model profile.
- [ ] Prove tool-call parsing, context bounds, inference/training residency,
  LoRA save/load, and cleanup on the admitted H100 topology.
- [ ] Measure a cheaper training judge against the official dual judges on the
  development matter; either pin it or use the dual pair for training.

### Phase 4 — Complete Week 0 training

- [ ] Run and archive the untrained development and frozen baselines.
- [ ] Pass one complete real-task staging preflight with final contracts.
- [ ] Launch and monitor the paid 16-group/four-rollout GRPO Run.
- [ ] Evaluate Candidate 1 on development and sealed Week 0 matters.
- [ ] Verify Policy/Taskset/rubric/artifact lineage, final LoRA durability,
  spend receipts, and complete CPU/GPU teardown.

### Phase 5 — Simulate Week 1 continual learning

- [ ] Reveal the Week 1 training/development release while preserving the
  sealed Week 1 frozen matter.
- [ ] Train Candidate 2 from Candidate 1 and preserve parent lineage.
- [ ] Evaluate Week 0 retention and Week 1 adaptation with the pinned judges.
- [ ] Verify artifacts, receipts, cleanup, and the retain/reject decision.

### Phase 6 — Publish the reproducible example

- [ ] Export and reinstall the complete `contract-review` Profile Release.
- [ ] Capture the Taskset, Agent/Skills, Run, metrics, trace, artifacts,
  comparison, cost, and Week 1 UI evidence.
- [ ] Write the case study and technical how-to from immutable receipts.
- [ ] Prepare an external LAB/leaderboard submission after the public subset
  result is reproducible.

## Validation

- Passed: source/license/task-family audit against LAB commit
  `a2b429eb6c9683c4fdeced3bc6b3af36edf239a6`.
- Passed: current-code audit of `profile-harness.ts`, `policy-gateway.ts`,
  `worker.py`, `training-batch.ts`, and OpenPond's Taskset Work runner.
- Passed: complete eleven-scenario ledger materialization at hash
  `b4531163449b8246e49b1489e25fd5eb622de591211d7b44fe1dd4cfedec85c6`.
- Passed: isolated Week 0 materialization at hash
  `9ef434ddaf456c1641a230038f2f2a4a79f44fcf658d79eb1ec8d65b2bc5c8c6`.
- Passed: hosted Work/multi-sample/rubric-reward contract and test suite.
- In progress: Qwen3-8B immutable worker image build and paid real-task
  preflight.
- Pending: paid Week 0 baseline, 16-group Run, frozen evaluation, and cleanup.
- Pending: Week 1 Run and retention/adaptation evidence.

## Open Questions

- Which exact immutable Qwen3-8B revision and vLLM-compatible tool parser pass
  the worker qualification suite?
- What bounded per-turn context and maximum turn count fit the admitted H100
  topology without truncating trainable completions?
- Does the official dual-judge cost justify a calibrated cheaper training judge
  after development agreement is measured?
- Is document-native tracked-change generation reliable in the current Work
  image, or does the generic document toolchain need one additional bundled
  dependency before the first real-task preflight?

## Progress Log

- 2026-08-30: Replaced the queued 0.6B synthetic legal demo with the active LAB
  flagship. Pinned the external source, selected MSA Week 0 and SaaS Week 1,
  chose Qwen3-8B, and made real Work trajectories and artifact rubrics required
  before paid training.
- 2026-08-30: Audited the current hosted path and found that its persistent CPU
  lane still executes a single Policy completion. Recorded the generic Work
  transport, multi-window training, artifact reward, and model-profile work
  needed for an honest legal Run.
- 2026-08-30: Implemented the generic hosted Work loop, immutable asset and
  output transport, per-turn training samples, context compaction, rubric
  reward, hosted baseline/candidate evaluation, and the pinned Qwen3-8B
  profile. Materialized the isolated Week 0 release and started its immutable
  worker-image build; paid execution remains gated on the real-task preflight.
