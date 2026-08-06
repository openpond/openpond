---
name: openpond-taskset-authoring
description: Create, improve, inspect, test, or prepare an OpenPond Taskset from a capability, Profile Agent, consented conversations, imported datasets, examples, and traces. Use when the user asks for training or evaluation tasks, graders, GRPO/RFT environments, baseline evaluation, Taskset readiness, or help deciding what a model should practice.
---

# OpenPond Taskset Authoring

Turn a normal chat request into a tested, reusable Taskset. The user should only
need a short sentence, for example:

> Build a Taskset that teaches a support triage agent to make consistent routing decisions.

Do not ask the user to provide internal names, IDs, schema fields, split-family
IDs, action names, approval booleans, or orchestration instructions. Infer
reversible defaults from the selected Profile, Agent, evidence, and current
conversation.

When a missing choice would materially change the tasks or their grading, ask
one plain-language question at a time. Ask only about:

- the repeated behavior the model should learn;
- the starting evidence or state it may see;
- the tools or actions it may use;
- what observable result should count as success;
- privacy, licensing, or data boundaries;
- task variety or run budget when the default is unsuitable.

## What a Taskset contains

A Taskset is a versioned, executable training and evaluation package:

- task instances and their source/data references;
- isolated training, validation, and frozen-evaluation splits;
- the Profile, Agent, Harness, tools, reset, and termination contract;
- graders, reward components, fixtures, and aggregate metrics;
- resource, network, private-verifier, and artifact boundaries;
- provenance plus an immutable, content-addressed release.

The dataset is the task collection or source data inside that package. It is
not the whole Taskset. A Model is also separate: submitting the first rollout or
training run should resolve a Model project, record base-policy version 0, and
attach the run to it. Taskset creation alone does not imply trained weights.

## Authoring workflow

1. Infer the capability and claim from the user's sentence.
2. Inspect only the selected Profile, Agent, tools, and consented evidence.
3. Separate stable behavior from changing knowledge. Recommend prompting,
   retrieval, or `no_training` when weights are not the right intervention.
4. Ask one focused question only when a material decision cannot be inferred.
5. Draft a compact proposal in product language, keeping policy-visible input
   separate from expected outcomes and private grader state.
6. Author varied tasks with semantic families isolated by split. Label examples
   `extracted`, `corrected`, `synthetic`, or `expert_authored`.
7. Prefer deterministic graders. Pin, calibrate, and version any model judge.
8. Use ordinary conversational confirmation before materializing the proposed
   Taskset. Do not expose the underlying action payload.
9. Validate schema and lifecycle, grader fixtures, leakage, reward hacking,
   optional reference-solution solvability, and a bounded base-model baseline.
10. Return a compact readiness summary and keep training as the next, separate
    action.

Use the installed Dataset Builder actions for design, materialization, and
testing, following their schemas internally. Do not recite those schemas in the
chat.

## Reviewing Work-first learning evidence

When `get_conversations` is available for continuous-learning authoring:

1. Call `get_conversations` exactly once without arguments. Never supply or
   infer an owner, Team, conversation list, source ID, watermark, or budget.
2. Treat the returned lanes differently. Work contains only sanitized summaries
   and content-addressed authoring references; never request or infer raw traces.
   Chat contains bounded conversation excerpts only for recurrence context.
   Do not search conversation archives, connected apps, files, or the web for
   additional evidence.
3. Rank verified, validation-backed Work above successful unverified Work, and
   successful Work above chat-only evidence. Failed, cancelled, or timed-out
   Work is discovery-only: it may reveal a repeated problem but never an
   approved demonstration, preference, evaluation target, or reward signal.
4. Use chat to establish missing recurrence and describe the repeated job. A
   candidate needs at least three independent returned source references before
   Taskset recommendation. Return at most three recommendations and explain
   whether the next step should be a Taskset, Skill, prompting, retrieval, or
   no action.
5. Treat accepted, correction, rejected, or mixed feedback as evidence that may
   change a recommendation. Feedback is never scalar reward, and a
   `rewardCandidate` value of false is authoritative.
6. Prefer retrieval or no action for changing knowledge, privacy-sensitive
   evidence, weak recurrence, or low-verifiability patterns.
7. Cite the returned source reference IDs without repeating unrestricted source
   content. If both lanes return no evidence, write a concise no-recommendation
   result using its reason.
8. If the Work item asks only for suggestions, stop after the recommendation.
   Do not materialize a Taskset, create a grader, start an Evaluation or
   training Run, create a Model Version, deploy, bind, or request Work compute.

Treat fixed synthetic smoke fixtures as diagnostics rather than evidence of a
general capability. Historical assistant messages are candidate outcomes, not
automatically approved demonstrations. Frozen evaluation tasks never become
prompt examples, repair context, demonstrations, or grader calibration data.

Read only the reference needed for the current decision:

- Task contracts, task reconstruction, and split isolation:
  `references/task-design.md`
- Graders, reward eligibility, and calibration:
  `references/graders-and-rewards.md`
- Method selection and readiness: `references/method-selection.md`
- Privacy, consent, and provenance:
  `references/privacy-and-provenance.md`
