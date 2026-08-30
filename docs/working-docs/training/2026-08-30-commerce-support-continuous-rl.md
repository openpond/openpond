# 2026-08-30 Commerce Support Continuous RL

Status: First low-cost synthetic RLAIF portfolio example after the shared
Sandbox Managed RL correctness and throughput prerequisite passes.

Latest checkpoint: 2026-08-30. Build the complete commerce-support product path
with a deliberately small synthetic Taskset, LLM-judged preference evidence,
frozen learned scorer, Qwen 0.6B, one 4-group GRPO candidate, a small frozen
evaluation, Agent-bound Chat, a second 4-group continual-learning candidate,
and an installable `commerce-support` Profile Release.

Parent plan:

- [Enterprise Agent Scenario Packs and Continuous GRPO](./2026-08-30-enterprise-agent-scenario-packs-and-continuous-grpo.md)
- [Sandbox Managed RL Reward Neutrality and Final Throughput Pass](../../../../sandbox/docs/working-docs/training/2026-08-30-managed-rl-reward-neutrality-and-final-throughput.md)
- [Portable Profile Releases](../profile/2026-08-30-portable-profile-releases.md)

Research inputs:

- [tau3-bench](https://github.com/sierra-research/tau2-bench)
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
6. a second evidence release produces and evaluates a continual-learning
   candidate from the retained demo parent; and
7. the exported Profile installs, validates, and runs in a clean Profile
   library.

## Current OpenPond Anchors

- `packages/evals/src/tasksets.ts` provides released stateful Environments,
  split isolation, tools, policies, limits, and graders.
- `packages/evals/src/execution-receipts.ts` composes reward components and hard
  gates into one Reward Receipt.
- `packages/evals/src/learned-preference.ts` versions preference groups,
  evidence authority, partitions, and Taskset lineage.
- `packages/contracts/src/training.ts` still needs a general trace-conditioned
  scorer input in addition to the Duck candidate-JSON processor.
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

Use tau3-bench as an MIT-licensed environment and taxonomy reference and ABCD
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

Use the pinned Qwen 0.6B base from the shared recipe. If it cannot produce a
valid multi-turn tool trajectory, record that capability result and select the
smallest supported Qwen that does. Use the lowest predicted-total-cost qualified
GPU that passes measured memory and runtime preflight; H100 is not the default.

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
even if it is flat or worse. It may become the retained demo parent when hard
safety/policy invariants pass, but it is not a production promotion. If those
invariants regress, Week 1 starts from the base. Inspect high-reward failures
for reward hacking before selecting the parent.

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

## Continual Learning Acceptance

After accepting the first candidate, simulate Week 1 with a concrete new support
window: a carrier outage creates delayed and lost-order cases, a policy revision
changes the allowable self-service credit, and LLM-judge feedback identifies
over-apology plus premature escalation. Then:

1. Produce a second authorized evidence window containing new failures,
   corrections, uncertain cases, and preference comparisons.
2. Redact, deduplicate, cluster, review, and create a second immutable Dataset
   and Taskset Release with a declared historical replay mixture.
3. Reuse the scorer if its rubric and held-out calibration remain valid;
   otherwise train, evaluate, and freeze a new scorer before Policy training.
4. Launch a second GRPO candidate from the retained demo parent through the same
   OpenPond Harness and Sandbox path.
5. Evaluate parent and candidate on the unchanged frozen set and compare them
   in Agent-bound Chat.
6. Record retain/reject evidence and prove terminal cleanup.
7. Prove the weekly workflow can be represented with the same immutable
   identities. Automated recurring scheduling is not required in this pass.

The simulated Week 1 uses a second 4-group x 4-sibling Run. Automatic recurring
scheduling and production promotion remain out of scope.

## Publication Package

After Candidate 2 executes, create two public drafts:

### Case study - How OpenPond learned a support team's workflow

- introduce the synthetic company and customer problem;
- show the `commerce-support` Agent and five Skills in the UI;
- compare representative base, Candidate 1, and Candidate 2 trajectories;
- explain the carrier-outage/policy-change Week 1 simulation;
- report frozen outcome, policy, preference, latency, and cost metrics;
- show the resulting LoRA lineage and Chat experience; and
- link the downloadable `commerce-support` Profile and show it running in a
  clean OpenPond installation.

### How-to - Build a continually learning support Agent

- reproduce Profile, Agent, Skill, tool, Environment, and Taskset creation;
- show how synthetic trajectories and LLM-judged preferences become the Reward
  Model;
- document the exact reward composer and GRPO recipe;
- walk through both Training Jobs in the UI;
- explain every chart, receipt, failure category, and cleanup result; and
- include commands, IDs/hashes safe for publication, and public artifact paths;
  and
- include Profile download, install, readiness-check, and update commands.

Capture the shared screenshot set plus support-specific order state before and
after tool use, the synthetic preference evidence surface, escalation evidence,
and a Week 0/Week 1 Chat comparison. Store raw evidence under
`docs/working-docs/training/assets/commerce-support/` and publication-safe
copies under `docs/research/assets/<date>-commerce-support/`.

## Cost Envelope

Planning caps before measured support timings:

| Work | GPU/API compute estimate | Excludes |
| --- | ---: | --- |
| Synthetic trajectories and 32-64 LLM-judged groups | `$0.50-$5` | Engineering time |
| Reward Model training, tiny held-out evaluation, and probes | `$1-$5` | Engineering time |
| First 4x4 GRPO Run plus frozen comparison | `$1-$6` | Engineering time |
| Week 1 evidence, second 4x4 Run, and comparison | `$1-$6` | Engineering time |
| First complete two-Run demo | `$4-$20` | Engineering time |

Actual Job and judge receipts are authoritative. The upper bound allows two
provider cold starts and retries; the target should fall after resident and
cache work. [RunPod's published pricing](https://www.runpod.io/pricing)
provides only the external hourly planning reference.

## Later Research Extension

If the completed portfolio selects Commerce Support, expand to at least 24/8/12
source clusters, 200-500 preference groups, at least 100 authorized human-
reviewed groups, a double-reviewed subset, a human-held-out scorer evaluation,
16+ rollout groups, stronger repeated trials, and an optional tau3-bench
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

### Phase 5 - Complete Continual Learning

- [ ] Create the second evidence and Taskset Release.
- [ ] Reuse or update the scorer through its own frozen acceptance.
- [ ] Train, evaluate, Chat-test, and retain/reject the second candidate.
- [ ] Prove the repeatable weekly workflow and immutable lineage.

### Phase 6 - Publish the Evidence

- [ ] Capture and redact the complete Week 0 and Week 1 UI screenshot set.
- [ ] Write the case-study and technical how-to research drafts from immutable
  receipts and completed artifacts.
- [ ] Export the complete `commerce-support` Profile, install it in a clean
  Profile library, pass checks, and link the pinned download from both drafts.
- [ ] Verify every metric, cost, screenshot, and link before marking the example
  complete.

## Validation

- Passed: current OpenPond contracts cover the required generic resource and
  reward shapes.
- Passed: Duck proved short end-to-end infrastructure and cleanup.
- Pending: every implementation and paid proof in this document.
- Pending: Week 0/Week 1 screenshots and both public research drafts.
- Pending: cost-aware qualified GPU selection for the demo resource profile.
- Skipped: no dataset import or paid Run was performed while authoring this doc.

## Open Questions

- Which low-cost LLM judge produces stable rubric decisions on the small
  held-out calibration set?
- Can pinned Qwen 0.6B produce valid multi-turn tool-use trajectories within
  the bounded support context?
- What predeclared component weights protect hard outcomes without making the
  learned preference signal irrelevant?
- What minimum new-evidence count should a later real schedule require?

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
