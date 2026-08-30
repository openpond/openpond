# 2026-08-30 Internal Knowledge Continuous RL

Status: Queued third low-cost synthetic RLAIF example. Do not implement until
Commerce Support and Internal Operations complete both demo Runs.

Latest checkpoint: 2026-08-30. This example will train an OpenPond-native
organization-assistant Agent to retrieve, cite, synthesize, abstain, route, and
act on internal knowledge. Changing facts remain in the corpus, Skills, and
memory; GRPO improves behavior over that knowledge. The proof includes an LLM-
judged synthetic scorer, Qwen 0.6B, one 4-group candidate, and one 4-group
continual-learning candidate, then ships as an installable
`organization-assistant` Profile Release.

Related docs:

- [Portfolio index](./2026-08-30-enterprise-agent-scenario-packs-and-continuous-grpo.md)
- [Commerce Support](./2026-08-30-commerce-support-continuous-rl.md)
- [Internal Operations](./2026-08-30-internal-operations-continuous-rl.md)
- [Portable Profile Releases](../profile/2026-08-30-portable-profile-releases.md)
- [Doc2Dial](https://github.com/IBM/doc-grounded-dialog-with-transformers)
- [MultiDoc2Dial](https://github.com/IBM/multidoc2dial)

## Outcome

Prove that OpenPond can continually improve an internal assistant's ability to
find and use organization knowledge without trying to memorize every weekly
document update into LoRA weights.

The Agent must answer with supported citations, notice conflicts and stale
sources, ask clarifying questions, abstain when evidence is insufficient,
respect access boundaries, route requests, and complete authorized downstream
actions. The first and second Policy candidates must be evaluated through the
same OpenPond Harness and versioned corpus.

## Profile and Harness

Profile: `organization-assistant`

Agent: `organization-assistant`

Skills:

- `knowledge-search`: plan queries across sources and reformulate when recall is
  weak.
- `source-evaluation`: compare authority, date, ownership, jurisdiction, and
  conflicting documents.
- `grounded-answer`: synthesize only supported claims with precise citations.
- `clarify-and-abstain`: ask for missing scope or decline unsupported answers.
- `request-routing`: identify responsible teams and create complete handoffs.
- `authorized-action`: convert grounded knowledge into a bounded ticket,
  request, or workflow action after confirmation.

Tools:

```text
search_documents
read_document
get_document_metadata
list_policy_versions
resolve_source_owner
search_people_and_teams
create_internal_ticket
request_confirmation
route_to_owner
save_answer_artifact
```

The OpenPond Harness owns context assembly, Skill loading, memory, tool calls,
and trace capture. Retrieval engines are tools behind the Harness, not an
alternative Agent runtime.

## Synthetic Organization and Corpus

Create an original organization with teams, products, policies, procedures,
benefits, security rules, architecture notes, incident history, FAQs, and
versioned decision records. Include realistic duplicates, superseded documents,
conflicts, missing sources, permission boundaries, and ownership changes.

Task families:

- single-source and multi-source grounded questions;
- policy comparison and effective-date reasoning;
- conflicting documents and authority resolution;
- missing evidence, ambiguity, and clarification;
- unsupported-premise and abstention cases;
- employee, customer, and confidential access boundaries;
- routing to the right owner with complete context;
- creating an authorized ticket or request from retrieved policy;
- long conversations requiring context management; and
- corpus updates that should change answers without Policy retraining.

## Demo Dataset

Author 8 training, 2 development, and 4 original frozen source clusters with
one or two compatible variations across query wording, user role, document
version, source conflict, missing evidence, or tool failure.
Freeze source-cluster assignments before trajectory generation.

Doc2Dial and MultiDoc2Dial may inform document-grounded dialogue, clarification,
and span-citation patterns after exact license and revision pinning. The public
showcase corpus, policies, people, and tasks remain original OpenPond synthetic
material. Do not use changing corpus documents as frozen evaluation answers
without pinning the corpus release.

The Environment release includes corpus inventory and hashes, access policy,
retrieval configuration, tool schemas, and reset contract. Every Attempt pins
the exact corpus release so retrieval changes cannot silently alter reward.

## Reward Contract

| Component | Evidence |
| --- | --- |
| Claim support | Claim-to-source spans and source content |
| Citation correctness | Document ID, version, span, and claim relationship |
| Source freshness/authority | Metadata, ownership, and policy rules |
| Access compliance | User role and tool authorization; hard gate |
| Clarification/abstention | Hidden objective and evidence availability |
| Routing/action correctness | Ticket/owner state and confirmation events |
| Answer usefulness | Synthetic-trained learned scorer over answer and trace |
| Search efficiency | Queries, documents opened, turns, tokens, latency |

Objective citation, authorization, routing, and action evidence must not be
overridden by the learned scorer. The scorer handles synthesis quality,
appropriate detail, clarity, prioritization, and whether the response is useful
given the retrieved evidence.

## Synthetic RLAIF Reward Model

Create 32-64 preference groups comparing complete trajectories. A declared LLM
judge sees the user role, policy-visible question, retrieved evidence,
citations, tool events, final answer, and downstream action. It may tie, reject
all, identify unsupported claims, mark access violations, or abstain. Store the
exact judge, prompt/rubric version, structured decision, token usage, cost, and
`synthetic_rlaif` authority; batch and cache identical requests by immutable
hash. No human review is required in this pass.

Freeze an untouched scorer-evaluation partition. Report held-out
pairwise ranking versus baseline, per-dimension agreement, calibration, ties,
reject-all behavior, and probes for citation decoration, verbosity, irrelevant
document stuffing, stale-source preference, answer-key leakage, and persuasive
unsupported claims. Record the held-out result with the frozen scorer version.

The scorer remains fixed during Policy GRPO. Corpus retrieval evidence supplied
to the scorer must be exactly what the Policy could observe.

## First GRPO Acceptance

Use pinned Qwen 0.6B and the lowest predicted-total-cost qualified GPU that
passes memory/runtime preflight. Run 4 rollout groups with four sibling
trajectories per prompt on the complete demo Taskset and exact corpus release.
Use the declared composed reward and corrected resident Managed RL path.

Frozen evaluation reports:

- supported-claim precision and required-claim coverage;
- citation span and document-version correctness;
- stale/conflicting source resolution;
- unsupported-claim and access-violation rates;
- clarification, abstention, and routing quality;
- authorized downstream-action correctness;
- learned usefulness reward;
- retrieval/tool efficiency, tokens, latency, and cost; and
- reward, KL, clip, gradient, artifact, durability, and cleanup receipts.

Report whether the candidate improves the declared grounded-helpfulness
objective. Preserve the immutable LoRA even when flat or worse. It may become
the retained demo parent when hard invariants pass, but a candidate that
increases unsupported claims, access violations, or stale-source use may not.

## Agent-bound Chat

Chat pins the Profile, Agent, Skills, Model Version, corpus release, retrieval
configuration, tools, and user role. It displays citations and trace evidence
and lets authorized reviewers mark complete trajectories for later dataset
review. It never silently promotes a conversation into training data.

The same Agent may later power a hosted internal chat surface, but website or
deployment work is not part of this training proof.

## Continual Learning Acceptance

Continual operation has two independent update streams:

1. **Knowledge release:** new or corrected documents change the versioned corpus
   and should affect answers immediately through retrieval.
2. **Learning release:** judged failures and preferences create a new Dataset
   and Taskset Release and may produce a new Policy candidate.

Simulate Week 1 by publishing a revised travel policy and security-escalation
procedure while leaving stale superseded documents discoverable. First confirm
the retained demo parent uses the new facts without weight training. Then add
LLM-judge evidence that the Week 0 Agent over-cited documents, failed to ask for
the employee's region, and routed an ambiguous security question too slowly.
Create the second behavioral evidence release with historical replay, reuse or
update the scorer, train a second 4-group Policy candidate, and compare it on the
unchanged frozen behavior set under declared corpus releases.

The demo proves the repeatable weekly workflow but does not require recurring
scheduler implementation. A future scheduler may coordinate both releases but
must not train merely because a document changed when no behavioral learning
evidence exists.

## Publication Package

After Candidate 2 executes, create:

### Case study - An internal assistant that learns how to use knowledge

- show the synthetic organization, Agent, Skills, and versioned corpus;
- compare grounded answers, citations, clarification, and routing before and
  after training;
- visually separate the Week 1 corpus update from the Week 1 weight update;
- show how the retained demo parent used new facts immediately through retrieval
  and whether Candidate 2 changed behavior through GRPO; and
- report support, citation, abstention, preference, latency, and cost metrics;
  and
- link the downloadable `organization-assistant` Profile and show it running
  with the bundled sample corpus in a clean OpenPond installation.

### How-to - Continual learning without memorizing your documents

- reproduce corpus releases, access policy, Profile, tools, Taskset, synthetic
  judge evidence, scorer, reward composer, GRPO recipe, and both Runs;
- walk through the UI's source citations, traces, model lineage, and schedule;
  and
- explain which changes require retrieval updates, Skill/Profile releases,
  Reward Model updates, or Policy training.

Capture the shared screenshot set plus corpus Release 1/2, source metadata,
answer citations, access denial, clarification, routing, and the side-by-side
“new facts without new weights” versus “new behavior with new weights” proof.
Use `docs/working-docs/training/assets/internal-knowledge/` for raw evidence and
`docs/research/assets/<date>-internal-knowledge/` for safe copies.

## Cost Envelope

Cap the first two-Run demo at `$5-$30` of GPU/judge compute. Keep documents and
retrieved context deliberately short, use 32-64 cached LLM judgments, two 4x4
Policy Runs, and the lowest predicted-total-cost
qualified GPU. Retrieval and judge tokens may still dominate GPU cost, so
receipts must separate corpus indexing, Harness execution, scorer inference,
Policy training, and judge calls.

## Later Research Extension

If selected after the four-demo comparison, expand Knowledge to at least
24/8/12 source clusters, 200-500 preference groups, at least 100 authorized
human-reviewed groups, double review, a human-held-out scorer evaluation, 16+
rollout groups, stronger repeated trials, and an optional Doc2Dial or
MultiDoc2Dial adapter and larger repeated evaluation.

## Boundaries

- Use the OpenPond Harness; retrieval is a tool.
- Do not memorize routine corpus updates into weights.
- Do not reward citations that do not substantively support claims.
- Do not expose unauthorized documents to the Policy, scorer, or reviewer.
- Do not let learned helpfulness compensate for unsupported claims.
- Do not add knowledge-specific platform API types.
- Do not begin before the first two examples pass.

## Phases

### Phase 1 - Build Complete Profile, Corpus, and Demo Dataset

- [ ] Implement Agent, Skills, tools, synthetic organization, corpus releases,
  access policy, 8/2/4 Taskset, reset, manifests, and deterministic graders.
- [ ] Pass citation, version, access, conflict, action, trace, and split tests.

### Phase 2 - Build the Synthetic RLAIF Reward Model

- [ ] Generate 32-64 preference groups, label them with the declared LLM judge,
  record synthetic provenance, and freeze the held-out subset.
- [ ] Train, evaluate, probe, and freeze the knowledge-quality scorer.

### Phase 3 - Complete the First Bounded GRPO Proof

- [ ] Run baseline, 4x4 GRPO, 4-case repeated comparison, Agent-bound Chat,
  artifact, spend, and cleanup proof.
- [ ] Accept or reject through the Model Project gate.

### Phase 4 - Complete Continual Learning

- [ ] Prove an independent corpus update without weight training.
- [ ] Create the second behavioral evidence release, train/evaluate the second
  candidate, inspect in Chat, retain/reject, and prove repeatable coordination.

### Phase 5 - Publish the Evidence

- [ ] Capture and redact the complete Week 0 and Week 1 screenshot set.
- [ ] Write and verify the case-study and technical how-to drafts from receipts.
- [ ] Export the complete `organization-assistant` Profile, install it in a
  clean Profile library with the sample corpus, pass checks, and link its pinned
  download.

## Validation

- Pending: this entire example; it is queued third.
- Pending: Week 0/Week 1 screenshots and both public research drafts.
- Skipped: no corpus, dataset, scorer, external benchmark, or paid Run was
  created while authoring this doc.

## Open Questions

- Which low-cost LLM judge is stable on groundedness, usefulness, and
  abstention preferences?
- Which retrieval implementation should back the generic tool contract for the
  first proof?
- Which corpus changes belong in the frozen behavior evaluation versus a
  separately versioned freshness evaluation?

## Progress Log

- 2026-08-30: Converted the first pass to a low-cost synthetic RLAIF demo with
  Qwen 0.6B, a bounded corpus and 8/2/4 scenarios, 32-64 LLM-judged groups, two
  4x4 Runs, a Portable Profile Release, and a deferred research extension.
- 2026-08-30: Added a corpus-plus-behavior Week 1 simulation, hybrid preference
  review, UI evidence capture, and case-study/how-to publication phase.
- 2026-08-30: Created as the third independent portfolio example, explicitly
  separating weekly knowledge updates from weekly Policy learning.
