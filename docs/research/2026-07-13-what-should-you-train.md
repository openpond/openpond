# What Should You Train?

## Turning everyday AI conversations into verifiable model tasks

The most important question in model training is usually asked too late.

Teams begin with a base model, a fine-tuning API, or a technique such as SFT or GRPO. They collect whatever conversations are nearby, turn them into JSONL, and start an optimizer. Only after the result disappoints them do they ask what behavior the model was supposed to learn.

The better starting point is simpler:

> I keep doing this. Can a smaller model learn the stable part?

That question begins with work rather than a training method. It also introduces the distinction on which useful organizational training depends: some parts of a workflow are stable behavior that can be learned, while other parts are changing knowledge, missing context, tool state, or one-time reasoning that should not be stored in model weights.

OpenPond should make that distinction before it offers a training button.

## Conversations contain evidence, not a ready-made dataset

People already perform valuable work with frontier models. They research markets, review documents, make product decisions, write software, revise analyses, and correct the model when its judgment is wrong. Those conversations contain unusually rich evidence:

- the original request;
- the context available at the time;
- the model's attempted response;
- tool calls and intermediate state;
- user corrections and accepted revisions;
- tests, runtime failures, and reviewer feedback; and
- the artifact or business outcome that followed.

But a conversation log is not automatically training data. An assistant response may be plausible but wrong. A later turn may contradict an earlier one. The answer may depend on documents that have since changed. A successful result may only make sense after several pages of hidden conversational context. Repeated discussion of one topic may represent repeated information retrieval, not a repeatable capability.

The first job of a training system is therefore not exporting messages. It is diagnosing the latent task represented by those messages.

## Repetition is not the same as trainability

Consider a set of conversations about web search. A miner can correctly observe that the topic recurs. It can extract several user prompts and assistant responses. Yet “answer questions about web search” combines at least three different jobs:

1. Recall current provider pricing, quotas, and product behavior.
2. Decide when an agent should search the web, fetch a known URL, or answer from existing context.
3. Research a product and recommend how its architecture should change.

The first job belongs in retrieval because its facts change. The second may be a stable tool-use policy suitable for demonstrations and evaluation. The third is a longer agentic process whose outcome may be better tested through code, documents, or product changes.

Training all three as one chat imitation task produces a dataset, but not a coherent capability.

This is where task mining must go beyond clustering. The useful output is not “these chats look similar.” It is a proposed behavioral boundary:

> Given this observable input and these available tools, produce this kind of outcome. Learn these stable judgments. Retrieve these changing facts. Do not memorize these incidental details.

## Match the signal to the intervention

Organizations generate different kinds of learning signals. They should not all be forced into one fine-tuning recipe.

| Evidence found in the workflow | Usually appropriate intervention |
| --- | --- |
| Changing documents, policies, prices, or internal facts | Retrieval and context management |
| Approved input-output demonstrations | Supervised fine-tuning |
| An original answer followed by an accepted correction | SFT on the correction and possibly preference tuning |
| Expert relevance or classification labels | Classification tuning, SFT, or verifiable RL after baseline testing |
| Deterministically verifiable outcomes | GRPO, RFT, or related RL when the base policy can reach reward-bearing states |
| Runtime, test, or reviewer feedback attached to attempts | SDPO-style learning when a supported backend can preserve the required feedback |
| Demonstrations available from a stronger teacher | Distillation, SDFT, or on-policy distillation where the teacher interface exposes the necessary signal |
| A long process involving tools, state, and side effects | An agentic environment with reset, observation, action, and grading contracts |
| A behavior the base model already performs reliably | Prompting, an agent instruction, or no change at all |

This mapping should be conservative. Training is not automatically the most advanced or valuable answer. “Do not train this” is a successful diagnosis when a prompt, retrieval system, or deterministic program will be cheaper and more reliable.

The recent collaboration between Bridgewater AIA Labs and Thinking Machines is instructive. Their target was not generic finance chat. They identified repeated constituent judgments in an investor's daily work, such as whether a document was relevant or where boilerplate began. They then acquired expert labels, found that non-expert labels were often wrong, created task-appropriate metrics, and iterated on training only after the task was measurable. Their result supports a future of differentiated organizational intelligence, but it also demonstrates how much of the work happens before the final training recipe.[^thinking-machines]

## Use an LLM for judgment, not for permission

The proposal for what a model should learn should be authored by a capable LLM. Hard-coding every possible business process would be both brittle and unpleasant. A frontier model can read selected evidence, reconstruct conversational context, infer candidate capabilities, identify contradictions, draft graders, and explain why a method fits.

That does not mean the entire system should be a prompt.

The LLM should propose:

- the behavioral objective and non-goals;
- the stable and changing parts of the workflow;
- the examples that appear successful;
- examples that need repair, rejection, or more context;
- missing cases and possible synthetic coverage;
- the appropriate training or non-training intervention;
- a grader or evaluation rubric; and
- an explanation a user can challenge and edit.

Deterministic product code should enforce:

- which conversations were explicitly selected and consented;
- provenance for every extracted or generated example;
- privacy, secret, licensing, and export boundaries;
- isolation between training and evaluation clusters;
- minimum independent evidence requirements;
- context-length and truncation checks;
- compatibility between the chosen task, grader, model, and backend;
- baseline execution and minimum evidence of possible improvement;
- separation between synthetic fixtures and representative examples; and
- separate approvals for authoring, materialization, compute spending, and data export.

The division is deliberate: the model decides what the evidence might mean; the application decides whether the proposal is internally consistent and safe to execute.

This is also why improving the authoring prompt alone is insufficient. A prompt cannot reliably refuse a bad formulation when the surrounding contract simultaneously requires it to emit a chat task, treats every selected assistant answer as a demonstration, and defaults ambiguous cases to SFT. The output schema, materializer, readiness rules, and user interface all shape the model's decision.

## Let the model prepare examples, but never hide where they came from

Most users should not have to invent dozens of training prompts manually. Their normal workflow should provide the starting evidence. The authoring model can then turn that evidence into a reviewable dataset.

For each proposed example, OpenPond should preserve one of three origins:

**Extracted** means the prompt and outcome came from an actual conversation. It should link to the source chat and show any context that was removed or reconstructed.

**Corrected** means a frontier model or the authoring system repaired formatting, restored necessary context, or substituted an explicitly accepted user correction. The transformation should be visible as a diff.

**Synthetic** means the example was created to cover a missing case. It should be clearly labeled, tied to an approved behavior specification, and validated before it is allowed to influence training.

Assistant messages from historical chats should begin as candidate outcomes, not approved truth. Acceptance, user correction, downstream success, tests, or expert review can strengthen them. Merely existing in a transcript cannot.

Users should be able to edit prompts and answers, but the primary editing surface should be the capability definition: what the model should do, what information it may use, and what success means. Once that boundary is correct, example-level review becomes a curation task rather than an exercise in authoring a dataset from scratch.

## Evaluation must exist before training

A model is only useful relative to work it did not train on.

Before enabling a production training run, OpenPond should exercise the base model on independent evaluation cases. The grader must match the task:

- exact match for truly canonical strings or boundaries;
- schema validation for structured output;
- tests and runtime assertions for code and tools;
- classification metrics for labels;
- grounded rubrics for open-ended judgments; and
- trajectory and state checks for agentic workflows.

Evaluation examples should come from independent conversations or purpose-built challenge cases, not merely later messages from the same trajectory. The system should measure whether the base model already succeeds, whether the grader distinguishes useful failures, and whether enough variation exists for the proposed learning method.

A cheap infrastructure smoke test is still valuable, but it must be named honestly. It proves that data can be exported, an optimizer can run, an adapter can be loaded, and evaluation can execute. It does not prove that a capability was learned.

That distinction matters. A two-step LoRA run on a tiny model can validate OpenPond's plumbing while producing no behavioral improvement. The UI should report “pipeline verified” separately from “quality improved.” A model artifact should not be presented as ready merely because the worker exited successfully.

## The product flow should begin with the job

The simplest user experience is one guided flow with two entry modes.

### Goal and conversations

In **Automated** mode, the user asks OpenPond to find repeated work worth training from a selected scope of consented conversations.

In **Manual** mode, the user describes a capability they already have in mind and selects representative conversations.

Both modes answer the same question: what recurring job is under consideration?

### Proposed setup

The authoring model returns a concise proposal:

- what the smaller model should learn;
- what should remain retrieval, tools, or application logic;
- the recommended intervention and why;
- evidence supporting the proposal;
- data and evaluation coverage;
- model-size and context requirements; and
- unresolved risks or missing examples.

The user can edit the proposal or choose a different method through an advanced control. They should not be forced to choose SFT or GRPO before seeing the diagnosis.

### Review Taskset

OpenPond shows the proposed training and evaluation examples with provenance, transformations, token lengths, split assignments, and grader behavior. The final action creates a versioned Taskset. It does not yet spend training compute.

Only after the Taskset passes readiness does the model page offer baseline comparison, base-model selection, destination selection, training, evaluation, and chat with the resulting artifact.

This produces a clean lifecycle:

```text
observed work
  -> candidate capability
  -> proposed intervention
  -> reviewed Taskset and grader
  -> baseline evidence
  -> approved training run
  -> evaluated model artifact
```

## The opportunity is task discovery

Training infrastructure is becoming easier to rent and easier to call. That does not make useful model training automatic. The scarce input is a defensible specification of organizational judgment: the recurring decision, the observable context, the approved outcome, and an evaluation that captures what experts actually value.

Conversation and agent traces are promising because they record work where it already happens. They reveal problems users repeat, corrections they make, tools they invoke, and outcomes they accept. But extracting value from them requires a system that can distinguish evidence from truth and repeated topics from learnable behavior.

That is the product OpenPond should become: not merely a button that converts chats into fine-tuning files, but an authoring and verification layer between everyday AI work and model training.

The durable question is not “Which training API should we call?”

It is:

> I keep doing this. Can a smaller model learn the stable part—and can we prove that it did?

[^thinking-machines]: Sarah Su, Kevin Zhu, Emily Xiao, Rohan Alur, and Daniel Kang, [“Learning to Replicate Expert Judgment in Financial Tasks,”](https://thinkingmachines.ai/news/learning-to-replicate-expert-judgment-in-financial-tasks/) Thinking Machines Lab and Bridgewater AIA Labs, June 30, 2026.
