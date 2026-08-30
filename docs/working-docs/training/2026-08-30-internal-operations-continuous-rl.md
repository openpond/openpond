# 2026-08-30 Internal Operations Continuous RL

Status: Queued second low-cost synthetic RLAIF example. Do not implement until
the Commerce Support demo completes both Runs.

Latest checkpoint: 2026-08-30. This example will train an OpenPond-native
operations Agent to diagnose and safely resolve synthetic incidents, access and
approval workflows, and internal operational failures. It uses the OpenPond
Harness, deterministic environment evidence, an LLM-judged synthetic scorer,
Qwen 0.6B, one 4-group GRPO candidate, and one 4-group continual-learning
candidate.

Related docs:

- [Portfolio index](./2026-08-30-enterprise-agent-scenario-packs-and-continuous-grpo.md)
- [Commerce Support](./2026-08-30-commerce-support-continuous-rl.md)
- [Sandbox throughput prerequisite](../../../../sandbox/docs/working-docs/training/2026-08-30-managed-rl-reward-neutrality-and-final-throughput.md)
- [Portable Profile Releases](../profile/2026-08-30-portable-profile-releases.md)
- [ITBench](https://github.com/itbench-hub/ITBench)
- [WorkArena](https://github.com/ServiceNow/WorkArena)

## Outcome

Prove that a client can train an Agent to reduce operational errors while
preserving approvals, authorization, audit evidence, and safe escalation. The
Agent must change or recover environment state—not merely write persuasive
incident summaries.

Completion requires an immutable synthetic-trained Reward Model and judge
provenance, an immutable GRPO LoRA candidate, a small frozen comparison, Agent-
bound Chat/Work inspection, resource cleanup, and a second continual-learning
candidate from new incident evidence. The completed example ships as an
installable `operations-resolution` Profile Release.

## Profile and Harness

Profile: `operations-resolution`

Agent: `operations-resolution`

Skills:

- `incident-triage`: establish impact, timeline, affected services, ownership,
  and missing evidence.
- `runbook-selection`: locate, validate, and follow the correct versioned
  procedure without treating runbooks as infallible.
- `change-approval`: classify risk and obtain required human authorization.
- `safe-remediation`: execute bounded, idempotent changes and verify recovery.
- `access-and-routing`: resolve or route access, procurement, onboarding, and
  compliance tasks to the correct owner.
- `postmortem-handoff`: produce an evidence-linked summary, unresolved risks,
  and next actions without fabricating causes.

Tools:

```text
read_alert
query_logs
query_metrics
get_service_owner
read_runbook
get_ticket
update_ticket
request_change_approval
apply_synthetic_change
verify_service_health
rollback_synthetic_change
route_request
escalate_incident
write_handoff
```

The OpenPond Harness loads the Profile and Skills and executes these tools in
resettable CPU sandboxes. Tools enforce permissions, approved change scope,
idempotency, rollback availability, and audit events. No external operations
harness is adopted.

## Environment and Dataset

Build a synthetic organization with services, dependencies, deployments,
alerts, logs, metrics, tickets, owners, runbooks, access policies, approvals,
and rollback state. Scenarios include:

- service degradation and dependency failure;
- bad deploy, configuration drift, capacity, and credential expiry;
- misleading alerts and incomplete observability;
- stale or incorrect runbooks;
- competing incidents and escalation priority;
- unauthorized or overly broad remediation attempts;
- access requests, onboarding/offboarding, procurement, and ticket routing;
- approval timeout, tool failure, partial remediation, and rollback; and
- postmortem evidence and unresolved follow-up.

Author 8 training, 2 development, and 4 original frozen source clusters with
one or two purposeful topology, evidence, ambiguity, approval, or failure-mode
variants. Source-cluster isolation is mandatory.

ITBench may inform environment topology, incident taxonomy, and evaluation
ideas. WorkArena may inform knowledge-work and enterprise-tool patterns. Neither
harness is the runtime, and no gated third-party ServiceNow instance is required.
Public records must retain exact source, revision, license, transformation, and
allowed-use provenance. The shipped public company and incidents are original
synthetic OpenPond data.

## Reward Contract

| Component | Evidence |
| --- | --- |
| Recovery and terminal state | Service graph, metrics, tickets, access state |
| Diagnosis quality | Required evidence and causal rubric |
| Authorization and approval | Capability and approval events; hard gate |
| Change safety | Scope, idempotency, verification, rollback |
| Runbook and source use | Versioned source references and trajectory |
| Escalation and routing | Ownership, severity, terminal handoff |
| Operator usefulness | Synthetic-trained learned scorer over the complete trace and artifacts |
| Efficiency | Turns, tokens, redundant queries, time to verified resolution |

Deterministic recovery and authorization evidence dominates. The learned scorer
evaluates prioritization, diagnosis explanation, evidence sufficiency, handoff
quality, and whether a competent operator would accept the proposed course. It
may not reward an elegant explanation of a wrong or unauthorized action.

## Synthetic RLAIF Reward Model

Create 32-64 preference groups comparing complete trajectories with tool
events, visible state, recovery evidence, and final artifacts. A declared LLM
judge can tie, reject all, flag unsafe behavior, record missing evidence, and
abstain. Store the exact judge, prompt/rubric version, structured decision,
token usage, cost, and `synthetic_rlaif` authority. Batch and cache identical
judgments by immutable request hash. No human reviewer is required in this pass.

Predeclare an untouched scorer-evaluation partition. Report held-out ranking
against the declared baseline with uncertainty, per-rubric agreement,
calibration, safe ordering of authorized versus unauthorized trajectories, and
probes against verbosity, fake certainty, irrelevant log volume, and apparent
recovery without verified state. Record the held-out result with the frozen
scorer version.

Scorer qualification remains Model Project evidence. The scorer is immutable
during each Policy Run.

## First GRPO Acceptance

Use pinned Qwen 0.6B and the lowest predicted-total-cost qualified GPU that
passes memory/runtime preflight. Run the complete demo Environment with 4
rollout groups and four sibling trajectories per group. Pin the complete
Profile, Environment, reward, scorer, recipe, parent Model, budgets, and
Sandbox placement.

Frozen evaluation reports:

- verified recovery and partial-recovery rates;
- unauthorized-change and missing-approval rates;
- correct rollback and idempotency behavior;
- diagnosis evidence and runbook selection;
- escalation precision/recall and handoff completeness;
- learned operator-preference reward;
- turns, tool calls, tokens, latency, and cost; and
- GRPO reward, KL, clipping, gradient, checkpoint, and cleanup evidence.

Retain the immutable candidate and report whether the declared operational
objective improves. A flat candidate may become the retained demo parent when
hard invariants pass, but it is not a production promotion. A candidate that
increases unauthorized change, false recovery, or missed escalation may not be
the Week 1 parent. Inspect every high-reward deterministic failure for reward
hacking.

## UI and Work Mode

Agent-bound Chat and Work use the same released Profile and Model Version. The
UI displays active Skills, tools, environment identity, approval events,
timeline, terminal state, reward components, and artifacts. Work mode may use
the same persistent resettable CPU sandbox for longer investigations; each
training Attempt still receives fresh state and capabilities.

No operations-specific API is added. Generic Model Project, Agent Run, Taskset,
Reward Model, Training Job, Model Version, and schedule resources carry the
example.

## Continual Learning Acceptance

Simulate Week 1 with a failed deployment that produces a misleading symptom, a
revised rollback runbook, and a new approval rule for high-risk changes. Add
LLM-judge feedback that the Week 0 Agent queried too many irrelevant logs and
underexplained residual risk. Redact and cluster this window, add a declared
replay sample, and produce a second Dataset/Taskset Release. Reuse the scorer
only if its rubric and calibration remain valid; otherwise update and freeze it
first.

Train the second 4-group candidate from the retained demo parent, evaluate
both on the unchanged frozen incidents, inspect in Agent-bound Chat/Work, and
retain or reject it. Prove the repeatable weekly workflow and lineage;
automated recurring scheduling and production changes remain out of scope.

## Publication Package

After the Week 1 candidate executes, create:

### Case study - Training an Agent to resolve incidents safely

- show the synthetic service graph, incident, Agent, and loaded Skills;
- tell one complete diagnosis/approval/remediation/recovery story;
- compare base, Candidate 1, and Candidate 2 on the failed-deploy Week 1 case;
- report recovery, authorization, rollback, escalation, preference, time, and
  cost metrics;
- report how the second weights changed evidence selection; and
- link the downloadable `operations-resolution` Profile and show it running
  in a clean OpenPond installation.

### How-to - Build an operations Reward Model and GRPO loop

- reproduce Profile, tools, resettable environment, Taskset, LLM-judge rubric,
  scorer, composed reward, GRPO recipe, and both Runs;
- walk through Chat/Work, approval events, traces, metrics, artifacts, receipts,
  and cleanup; and
- explain how the Week 1 Dataset release and retained demo-parent lineage work.

Capture the shared screenshot set plus the service graph, alert/log/metric tool
timeline, approval, before/after health, rollback evidence, and Week 1 lineage.
Use `docs/working-docs/training/assets/internal-operations/` for raw evidence and
`docs/research/assets/<date>-internal-operations/` for publication-safe copies.

## Cost Envelope

Environment rollout duration is unknown until Commerce Support establishes the
resident throughput baseline. Cap the first two-Run demo at `$5-$25` of
GPU/judge compute. Use 32-64 cached LLM judgments,
two 4x4 Policy Runs, and the lowest predicted-total-cost qualified GPU. Record
actual CPU sandbox occupancy because long incident traces may move cost from GPU
training into Harness execution and judge calls.

## Later Research Extension

If selected after the four-demo comparison, expand Operations to at least
24/8/12 source clusters, 150-400 preference groups, at least 75 experienced
human-reviewed groups, double review, human-held-out scorer evaluation, 16+
rollout groups, stronger repeated trials, and an optional ITBench or WorkArena
evaluation adapter and larger repeated evaluation.

## Boundaries

- Use only the OpenPond Harness and resettable synthetic environment.
- Do not connect training tools to real production mutation endpoints.
- Do not let learned reward override authorization or verified recovery.
- Do not treat a written incident summary as terminal success.
- Do not add operations-specific platform resources.
- Do not begin until Commerce Support passes end to end.

## Phases

### Phase 1 - Build Complete Operations Profile and Demo Environment

- [ ] Implement Agent, Skills, tools, policies, reset, synthetic organization,
  8/2/4 Taskset, manifests, and deterministic verification.
- [ ] Pass demo-dataset authorization, approval, rollback, idempotency, timeout,
  trace, and split-isolation tests.

### Phase 2 - Build the Synthetic RLAIF Reward Model

- [ ] Generate 32-64 preference groups, label them with the declared LLM judge,
  record synthetic provenance, and freeze the held-out subset.
- [ ] Train, evaluate, probe, and freeze the operations scorer.

### Phase 3 - Complete the First Bounded GRPO Proof

- [ ] Run baseline, 4x4 GRPO, 4-case repeated comparison, Chat/Work inspection,
  durability, spend, and cleanup.
- [ ] Accept or reject through the Model Project gate.

### Phase 4 - Complete Continual Learning

- [ ] Create the second evidence release and replay mixture.
- [ ] Reuse or update the scorer, train the second candidate, evaluate, inspect,
  retain/reject, and prove the repeatable weekly workflow.

### Phase 5 - Publish the Evidence

- [ ] Capture and redact the complete Week 0 and Week 1 screenshot set.
- [ ] Write and verify the case-study and technical how-to drafts from receipts.
- [ ] Export the complete `operations-resolution` Profile, install it in a
  clean Profile library, pass checks, and link its pinned download.

## Validation

- Pending: this entire example; it is queued behind Commerce Support.
- Pending: Week 0/Week 1 screenshots and both public research drafts.
- Skipped: no environment, dataset, scorer, benchmark adapter, or paid Run was
  created while authoring this doc.

## Open Questions

- Which bounded operational subdomain best fits the first 8/2/4 demo:
  service incidents, access workflows, or a mixed pack?
- Which low-cost LLM judge is stable on the declared operations rubric?
- Which synthetic service topology is complex enough to be realistic without
  making reset and diagnosis opaque?

## Progress Log

- 2026-08-30: Converted the first pass to a low-cost synthetic RLAIF demo with
  Qwen 0.6B, 8/2/4 scenarios, 32-64 LLM-judged groups, two 4x4 Runs, a Portable
  Profile Release, and a deferred research extension.
- 2026-08-30: Added a failed-deploy/runbook/approval Week 1 simulation, hybrid
  preference review, UI evidence capture, and case-study/how-to publication
  phase.
- 2026-08-30: Created as the second independent portfolio example with a full
  OpenPond-native Reward Model, GRPO, Chat/Work, and continual-learning path.
