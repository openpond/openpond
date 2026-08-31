# 2026-08-30 Commerce Support Continuous RL

Status: Active Phase 7 input and first-Run plan. Shared Sandbox Managed RL
correctness and throughput prerequisites pass, but the commerce-support assets
do not exist yet. There is no executable support Taskset, support Model Project,
frozen support Evaluation, preference release, or support Reward Model Version
in the current OpenPond dev state.

Latest checkpoint: 2026-08-31. Build one original stateful commerce-support
Taskset, deterministic support verifier, synthetic preference release,
support-specific learned communication scorer, Qwen3-8B rank-16 Policy
candidate, frozen comparison, and installable `commerce-support` Profile
Release. Stop after the first candidate and cleanup. Residual ranks, release
trains, and later continual Runs are owned by the separate residual-LoRA plan.

Parent plan:

- [Enterprise Agent Scenario Packs and Continuous GRPO](./2026-08-30-enterprise-agent-scenario-packs-and-continuous-grpo.md)
- [Sandbox Managed RL Reward Neutrality and Final Throughput Pass](../../../../sandbox/docs/working-docs/training/2026-08-30-managed-rl-reward-neutrality-and-final-throughput.md)
- [Portable Profile Releases](../profile/2026-08-30-portable-profile-releases.md)
- [Commerce-Support Residual LoRA Release Train](../../../../sandbox/docs/working-docs/training/2026-08-31-commerce-support-residual-lora-release-train.md)

Research inputs:

- [tau2-bench](https://github.com/sierra-research/tau2-bench)
- [ABCD](https://github.com/asappresearch/abcd)

## Outcome

Prove that OpenPond can improve a small, hosted Policy Model at resolving
realistic commerce-support work through the exact Harness used at runtime. The
result must be more than JSON-format learning: the Agent holds a multi-turn
conversation, reads and mutates state with tools, follows policy and approval
boundaries, resolves or escalates the issue, and communicates in the team's
preferred style.

The demo is complete only when:

1. a synthetic-trained Reward Model has immutable judge provenance and an
   untouched evaluation;
2. a bounded GRPO Run produces an immutable LoRA Model Version;
3. parent and candidate complete the frozen support comparison, whether the
   result improves, regresses, or is flat;
4. base/current/candidate work in Agent-bound Chat;
5. all GPU and Harness resources are cleaned up; and
6. the exported Profile installs, validates, and runs in a clean Profile
   library.

## Current Readiness Audit

- The only ready support-named dev Taskset is `Renewal Risk Triage`
  (`reconcile-crm-billing-and-support-8c183779`, revision 14): 50 train, 10
  validation, and 10 frozen tasks using `search_crm`, `query_billing`,
  `search_support`, `run_python`, and `cross_system_trajectory`. Its objective is
  deterministic reconciliation of CRM, billing, and support records. It is not
  a conversational commerce-support benchmark and must not be relabeled.
- The dev store contains three Reward Model Versions, all Duck-specific. Two
  use `Qwen/Qwen3-0.6B`; one uses SigLIP. None may be reused as the support
  scorer.
- The managed Policy profile supports exact `Qwen/Qwen3-8B` at revision
  `b968826d9c46dd6066d109eabc6255188de91218` with LoRA rank 16. The managed
  Reward Model profile separately pins `Qwen/Qwen3-0.6B` at revision
  `c1899de289a04d12100db370d81485cdf75e47ca`.
- OpenPond now represents `support_visible_trajectory_v1` scorer inputs. The
  schema includes policy-visible conversation, tool/runtime events, final
  visible state, escalation, and termination and rejects hidden-answer,
  privileged, reward, and score leakage. No preference data has been
  materialized and no support scorer has been trained.
- tau2-bench retail is the executable policy/tool/database/task-schema
  reference. ABCD is the dialogue, intent, and action-flow reference. Phase 7
  authors original OpenPond source clusters from those taxonomies rather than
  training on the external benchmark's held-out tasks.

## Current OpenPond Anchors

- `packages/evals/src/tasksets.ts` provides released stateful Environments,
  split isolation, tools, policies, limits, and graders.
- `packages/evals/src/execution-receipts.ts` composes reward components and hard
  gates into one Reward Receipt.
- `packages/evals/src/learned-preference.ts` versions preference groups,
  evidence authority, partitions, and Taskset lineage.
- `packages/contracts/src/training.ts` now declares
  `support_visible_trajectory_v1`, and
  `apps/server/src/training/support-reward-trajectory.ts` validates the bounded
  policy-visible support trace before Reward Model launch.
- `apps/server/src/training/learned-preference-reward-binding.ts` already pins
  scorer, processor, composer, and receipt identity for a Policy Run.
- `apps/web/src/lib/training-model-chat-handoff.ts` already hands a Model Version
  and Taskset into bounded Chat but does not yet pin the full Profile/Agent/Skill
  release graph.

## Profile and Harness

Profile: `commerce-support`

Agent: `commerce-support`

Initial Skills:

- `order-investigation`: authenticate, gather order facts, distinguish delay,
  loss, wrong delivery, missing items, and stale tracking.
- `refund-and-replacement`: apply policy, calculate eligible scope, prevent
  duplicate remedies, and verify terminal state.
- `cancellation-and-subscription`: handle fulfillment cutoffs, subscription
  pause/cancel/renewal, and conflicting requests.
- `confirmation-and-escalation`: obtain explicit approval before mutations and
  escalate exceptions with a complete handoff.
- `support-voice`: communicate clearly, empathetically, concisely, and in the
  synthetic company's declared voice without promising unavailable outcomes.

Tools:

```text
get_customer
get_order
get_shipment
read_policy
issue_refund
replace_item
update_address
cancel_order
change_subscription
apply_credit
request_confirmation
escalate_to_human
```

Tool code—not prompts or reward—enforces authentication, monetary limits,
authorization, idempotency, irreversible-action boundaries, and tenant state.
Every rollout receives a fresh reset state and one-use capabilities while the
job-scoped CPU lane remains persistent.

## Stateful Synthetic Company

Create an original public commerce company with customers, orders, line items,
shipments, payments, credits, subscriptions, prior contacts, risk flags, and
versioned policies. The environment must expose only policy-visible state to the
Agent while preserving hidden user objectives and expected terminal state for
evaluation.

Issue families:

- delayed, lost, damaged, incomplete, or incorrect orders;
- refunds, partial refunds, replacements, and substitutions;
- cancellation before and after fulfillment boundaries;
- subscription pause, cancellation, and renewal;
- address correction and account verification;
- credits, promotions, and price-adjustment limits;
- ambiguous, conflicting, and multi-issue requests;
- required confirmation before state mutation;
- stale reads, tool timeout, retry, and duplicate requests;
- policy exceptions and human escalation; and
- adversarial attempts to bypass identity, policy, or monetary limits.

## Demo Dataset

Author before paid Reward Model or Policy training:

- 8 training source clusters;
- 2 development source clusters;
- 4 original frozen-evaluation source clusters; and
- one or two purposeful variants per compatible cluster covering state,
  language, tone, ambiguity, policy version, or tool failure.

`clusterKey` keeps every derivative of one source scenario inside one split.
The frozen set is original OpenPond material, never sampled by the user
simulator during training and never used for scorer fitting.

Use tau2-bench as an MIT-licensed environment and taxonomy reference and ABCD
as an MIT-licensed source of support flows, language, intents, and action
sequences. Do not copy their benchmark test tasks into OpenPond training and
use them as the frozen OpenPond evaluation. Raw dialogue rows must be converted
into executable initial state, tools, hidden objective, terminal state, limits,
and verifier evidence.

Every imported or transformed item pins source URL, commit/revision, license,
record identity where permitted, transformation version, consent/PII posture,
cluster identity, and allowed use.

## Reward Contract

Each scorable trajectory emits separately inspectable components:

| Component | Evidence | Default role |
| --- | --- | --- |
| Terminal resolution | State diff and hidden objective | High-weight deterministic |
| Policy compliance | Policy version, tool events, final state | Deterministic; hard gate only for real invariants |
| Confirmation and authorization | Runtime capability and approval events | Deterministic hard gate |
| Tool correctness | Calls, arguments, ordering, retries, idempotency | Deterministic |
| Escalation | Scenario rule, handoff contents, terminal state | Deterministic plus rubric for ambiguity |
| Communication quality | Complete visible trajectory and rubric | Synthetic-trained learned scorer |
| Efficiency | Turns, tokens, unnecessary calls, latency | Declared shaping component, never hidden platform logic |

The Model Project declares weights and gates. Equal finite group rewards remain
valid zero-signal evidence and must not fail managed infrastructure.

## Synthetic RLAIF Reward Model

The scorer input is a deterministic, bounded serialization of policy-visible
scenario context, rubric, conversation turns, tool calls/results, runtime
events, final visible state, escalation, artifacts, and truncation metadata. It
must not contain hidden expected answers, privileged grader fields, secrets,
other candidates, or their scores.

Create 32-64 preference groups with two to four complete trajectories per
group. A declared external LLM judge sees only policy-visible evidence and the
support rubric and may order candidates, tie, reject all, flag policy
violations, record rubric dimensions, or abstain. Batch and cache identical
judge requests by immutable hash. Store judge provider/model revision, prompt
and rubric version, sampling configuration, raw structured decision, token
usage, cost, and evidence authority `synthetic_rlaif`.

Freeze train, development, and untouched scorer-evaluation partitions before
training. Report whether the first scorer:

- exceed the declared majority/random baseline on held-out pairwise ordering,
  with uncertainty reported;
- beats the declared baseline on held-out non-tied pairwise accuracy;
- preserve ties and reject-all cases rather than forcing false rankings;
- report per-rubric agreement and calibration;
- show no material preference for policy-violating or outcome-wrong answers
  merely because their wording is polished; and
- pass paraphrase, verbosity, formatting, tool-result injection, and hidden-
  answer leakage probes.

Record the held-out result in Model Project evidence. Sandbox executes the
authorized scorer without enforcing a project-specific quality threshold.

## First GRPO Acceptance

Use the current exact managed `Qwen/Qwen3-8B` Policy profile. Do not substitute
the Duck-era 0.6B Policy recipe: the managed worker no longer supports it as a
Policy base, and it has not demonstrated reliable bounded multi-turn support
tool use. The support Reward Model remains a separate Qwen3-0.6B scorer. Use
the caller-selected supported GPU placement objective after measured memory and
runtime preflight; H100 is not a quality requirement.

The first paid demo Run uses:

- the released demo training dataset;
- 4 rollout groups;
- four sibling trajectories per group from one exact Policy Version;
- the frozen support scorer and reward composer;
- declared standardized group advantages, shaping, fixed-reference KL,
  clipping, optimizer iterations, and budgets; and
- complete rollout, score, optimizer, checkpoint, activation, durability,
  spend, and cleanup receipts.

Comparison uses the 4-case frozen set with two deterministic repeats for parent
and candidate. Report terminal success, policy and authorization
violations, confirmation, escalation precision/recall, tool errors and retries,
communication reward, turns, tokens, latency, cost, reward distribution, KL,
clip fraction, and gradient movement. Retain the LoRA as an immutable candidate
even if it is flat or worse. It may become a later experiment seed when hard
safety/policy invariants pass, but it is not a production promotion. Inspect
high-reward failures for reward hacking before selecting the seed.

## Agent-bound Chat

The Model Project Chat action must pin and display:

- `commerce-support` Profile release;
- Agent and enabled Skill releases;
- exact base/current/candidate Model Version;
- Environment, policy, tool, and Taskset release;
- selected scenario or free-form user turn; and
- complete conversation/tool/state trace.

Chat supports product inspection and preference collection. It does not replace
frozen evaluation or silently add a trace to the next Dataset.

## Deferred Continual and Residual Learning

Phase 7 stops after Candidate 1. A later experiment may use that immutable
adapter as its seed, but this doc does not prescribe Week 1, a second GRPO Job,
lower ranks, stacked residuals, replay, scorer refresh, consolidation, or
promotion automation. The linked residual-LoRA plan owns those hypotheses and
must first expand beyond the 14-cluster demo if it wants to test 25-, 50-, or
100-cluster releases.

## Publication Package

After Candidate 1 executes, create two public drafts:

### Case study - How OpenPond learned a support team's workflow

- introduce the synthetic company and customer problem;
- show the `commerce-support` Agent and five Skills in the UI;
- compare representative base and Candidate 1 trajectories;
- report frozen outcome, policy, preference, latency, and cost metrics;
- show the resulting LoRA lineage and Chat experience; and
- link the downloadable `commerce-support` Profile and show it running in a
  clean OpenPond installation.

### How-to - Train a stateful commerce-support Agent

- reproduce Profile, Agent, Skill, tool, Environment, and Taskset creation;
- show how synthetic trajectories and LLM-judged preferences become the Reward
  Model;
- document the exact reward composer and GRPO recipe;
- walk through the Training Job in the UI;
- explain every chart, receipt, failure category, and cleanup result; and
- include commands, IDs/hashes safe for publication, and public artifact paths;
  and
- include Profile download, install, readiness-check, and update commands.

Capture the shared screenshot set plus support-specific order state before and
after tool use, the synthetic preference evidence surface, escalation evidence,
and a base/Candidate 1 Chat comparison. Store raw evidence under
`docs/working-docs/training/assets/commerce-support/` and publication-safe
copies under `docs/research/assets/<date>-commerce-support/`.

## Cost Envelope

Planning caps before measured support timings:

| Work | GPU/API compute estimate | Excludes |
| --- | ---: | --- |
| Synthetic trajectories and 32-64 LLM-judged groups | `$0.50-$5` | Engineering time |
| Reward Model training, tiny held-out evaluation, and probes | `$1-$5` | Engineering time |
| First 4x4 GRPO Run plus frozen comparison | `$1-$6` | Engineering time |
| First complete one-Run demo | `$3-$16` | Engineering time |

Actual Job and judge receipts are authoritative. The upper bound allows a
provider cold start and one retry; the target should fall after resident and
cache work. [RunPod's published pricing](https://www.runpod.io/pricing)
provides only the external hourly planning reference.

## Later Research Extension

If the completed portfolio selects Commerce Support, expand to at least 24/8/12
source clusters, 200-500 preference groups, at least 100 authorized human-
reviewed groups, a double-reviewed subset, a human-held-out scorer evaluation,
16+ rollout groups, stronger repeated trials, and an optional tau2-bench
adapter and larger repeated evaluation.

## Boundaries

- Use the OpenPond Harness exclusively.
- Do not add a separate smoke Run before the bounded demo without a specific
  infrastructure reason.
- Do not train the scorer and Policy simultaneously.
- Do not use learned tone reward to override unsafe or wrong state transitions.
- Do not leak frozen cases or hidden objectives into scorer or Policy inputs.
- Do not add commerce-specific API or Sandbox resource types.
- Do not begin the other three portfolio examples before this doc passes.
- Do not include website deployment or automatic production promotion.

## Phases

### Phase 1 - Finish Shared Managed RL Prerequisite

- [ ] Complete and accept the linked Sandbox reward/protocol/throughput work.
- [ ] Run one bounded infrastructure regression and prove cleanup.

### Phase 2 - Build Complete Profile and Bounded Demo Dataset

- [ ] Implement the Profile, Agent, Skills, tools, policies, reset, simulator,
  terminal-state verifier, source manifest, and 8/2/4 Taskset.
- [ ] Pass deterministic demo-dataset reset, authorization, idempotency,
  timeout, retry, trace, and split-isolation tests.
- [ ] Extend generic Model Project Chat identity where required.

### Phase 3 - Build the Synthetic RLAIF Reward Model

- [ ] Generate 32-64 preference groups, label them with the declared LLM judge,
  record synthetic provenance, and freeze the held-out evaluation.
- [ ] Train, evaluate, probe, and freeze the trace-conditioned scorer.
- [ ] Record the Model Project acceptance evidence and immutable binding.

### Phase 4 - Complete the First Bounded GRPO Proof

- [ ] Run the baseline, 4x4 GRPO job, 4-case repeated frozen comparison,
  Agent-bound Chat comparison, artifact durability, spend, and cleanup proof.
- [ ] Accept or reject the candidate using the declared gate.

### Phase 5 - Publish the Evidence

- [ ] Capture and redact the complete input, scorer, Run, Evaluation, and Chat
  screenshot set.
- [ ] Write the case-study and technical how-to research drafts from immutable
  receipts and completed artifacts.
- [ ] Export the complete `commerce-support` Profile, install it in a clean
  Profile library, pass checks, and link the pinned download from both drafts.
- [ ] Verify every metric, cost, screenshot, and link before marking the example
  complete.

### Deferred - Continual and Residual Study

- [ ] Continue only through the separate Commerce Support Residual LoRA plan
  after the first Taskset, scorer, candidate, frozen comparison, and cleanup are
  complete.

## Validation

- Passed: current OpenPond contracts cover the required generic resource and
  reward shapes.
- Passed: Duck proved short end-to-end infrastructure and cleanup.
- Pending: every implementation and paid proof in this document.
- Pending: first-Run screenshots and both public research drafts.
- Pending: caller-owned supported GPU placement for the demo resource profile.
- Skipped: no dataset import or paid Run was performed while authoring this doc.

## Open Questions

- Which low-cost LLM judge produces stable rubric decisions on the small
  held-out calibration set?
- Does pinned Qwen3-8B reliably produce valid multi-turn tool-use trajectories
  within the bounded support context and four-group budget?
- What predeclared component weights protect hard outcomes without making the
  learned preference signal irrelevant?
- What minimum new-evidence count should a later residual study test? This is
  not a Phase 7 launch gate.

## Progress Log

- 2026-08-30: Converted the first pass from a human-backed flagship study to a
  complete low-cost synthetic RLAIF example: Qwen 0.6B, 8/2/4 scenarios, 32-64
  LLM-judged groups, two 4x4 Policy Runs, a Portable Profile Release, and a later
  research extension.
- 2026-08-30: Added a carrier-outage/policy-change Week 1 simulation, hybrid
  preference review, UI evidence capture, and case-study/how-to publication
  phase.
- 2026-08-30: Created as the first independent end-to-end portfolio example.
  Locked the full dataset, human-backed Reward Model, GRPO, Chat, and continual-
  learning objective on the OpenPond Harness.
- 2026-08-31: Re-audited the dev store and separated the first executable
  commerce-support proof from later residual learning. Renewal Risk Triage is a
  different cross-system Taskset; every stored Reward Model is Duck-specific.
  Phase 7 now builds an original 8/2/4 support Taskset, trains a new
  Qwen3-0.6B trace-conditioned support scorer, and runs one rank-16 Qwen3-8B
  Policy candidate before cleanup. The residual release train is deferred.
