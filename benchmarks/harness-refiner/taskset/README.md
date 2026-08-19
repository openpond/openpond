# Harness Refiner Taskset Design

Status: Taskset Release materialized; deterministic local-runtime conformance
and the 20260818-v2 controlled run completed.

This directory contains the canonical `openpond.tasksetRelease.v2` used by the
Harness Refiner benchmark. Benchmarking is a first-class Taskset purpose: the
same portable cases, assets, graders, and receipts appear in the Tasksets UI,
while the benchmark protocol controls paired execution and comparison. Running
this benchmark does not start a training job.

- Release: [`taskset.release.json`](./taskset.release.json)
- Release id: `harness-refiner-20260818-v2`
- Revision: `2`
- Content hash:
  `20e247cec268ecb6380bc7af204abc9056f7eaa90e1e85aa5e11544f2506888d`
- Historical release:
  [`harness-refiner-08112026.json`](./releases/harness-refiner-08112026.json)
- Rebuild: `pnpm benchmark:harness-refiner:build`
- Conformance: `pnpm benchmark:harness-refiner:conformance`

## Split

All twenty prompts must read like real requests from a person using an agent.
They must not name Refiner, Harness internals, benchmark paths, tool names, or
workspace layout.

| Family | Adaptation cases | Frozen-evaluation cases |
| --- | ---: | ---: |
| Artifact creation and verification | 3 | 3 |
| Current or primary-source research | 3 | 3 |
| Direct-deliverable everyday work | 4 | 4 |
| Total | 10 | 10 |

Every case carries exactly one neutral behavioral-family tag. Adaptation and
frozen-evaluation cases share those family labels, but may not share a source
document, expected answer, entity set, or source-cluster key. Refiner receives
each fact-distinct adaptation attempt after it completes, along with bounded
prior observations from the same isolated Harness workspace. The next ordered
adaptation task uses the resulting immutable Harness release. Frozen prompts,
labels, and results remain hidden until the final Harness is frozen.

## Case families

The release covers these general behaviors across different
subjects in each split:

- produce a bounded PDF from a supplied decision packet and visually verify it;
- produce a bounded PDF from a supplied incident or operations packet without
  collapsing confirmed facts and open hypotheses;
- create and verify a structured spreadsheet or presentation artifact;
- audit a software stack using primary security advisories without inferring
  exposure from an advisory alone;
- verify a time-sensitive travel or accessibility plan from official evidence;
- find eligible time-sensitive funding opportunities without padding the list;
- summarize recent public ChatGPT experiences from X and Reddit with direct
  links, dates, balanced evidence, and sampling limitations;
- complete four fact-distinct, concise communications by returning the actual
  send-ready copy rather than only a file path, completion claim, summary, or
  requirements checklist.

The held-out split uses different documents, organizations, routes, software,
and communication scenarios while preserving the same reusable failure
classes. Its direct-deliverable cases vary across email, team chat, and support
reply so a candidate must generalize beyond one prompt template.

## Evidence contract

Each attempt retains the visible request and answer, runtime and tool receipts,
generated artifacts, deterministic checks, canonical reward receipts, and
authoritative provider usage.

For adaptation cases, Refiner receives bounded neutral facts,
content-addressed references, requests, user-visible outputs, artifact checks,
final grader receipts, bounded expected-output contracts, execution cost, and
a bounded window of prior raw observations after grading. The model decides
whether differently worded observations share a reusable root behavior and
chooses the smallest justified Harness change or external route. Deterministic code enforces
authorization, budgets, schemas, paths, hashes, validation, atomic application,
and rollback; it does not choose the semantic diagnosis or route.

Frozen-evaluation prompts, privileged expected outcomes, deterministic
contracts, and results remain unavailable to Refiner until the candidate
Harness is frozen.

The primary reward is produced by one sandboxed deterministic verifier. It
checks required artifact type and validation receipts, explicit message facts,
word limits, direct-link/report structure, and declared prohibitions. This is
an output-contract reward, not a claim that every factual or aesthetic detail
has been judged. The richer quality rubric remains a content-addressed,
uncalibrated supplementary artifact and is not executed, weighted, or allowed
to block primary reward.

## Materialization and execution gate

The checked-in release now satisfies these materialization requirements:

- all twenty prompts and split assignments are frozen;
- every fixture and rubric has an immutable asset reference and content hash;
- production tool declarations and capability requirements are captured from
  the qualified runtime rather than rewritten by hand;
- the deterministic verifier and supplementary rubric are immutable assets;
- `@openpond/evals` validates the release and rejects split-cluster
  contamination;
- the projected app Taskset round-trips to the admitted portable environment,
  tool, task, capability, and verifier contracts; and
- a scripted no-training Work attempt earned a scored reward of `1`, persisted
  its artifact manifest, attempt receipt, reward receipt, and Evaluation
  result, and made zero model-judge calls.

The supplementary model judge remains explicitly `pending` until separate
calibration evidence exists. It is not part of this release's executable
Verifier Set.

The portable source release is bound to immutable Environment and Verifier Set
releases before execution. The resulting execution Taskset hash for the sealed
20260818-v2 run is
`c4cb8a543c22ef397ea7bc5192fb0be9baea40b0323674fc66f36794af182a6d`.
The source and execution hashes identify different layers of the same admitted
release graph and are both verified by the benchmark audit.

The sealed natural-task result accepted no Harness change and is classified as
inconclusive. See the [benchmark result](../results/harness-refiner-20260818-v2.json)
for the complete paired aggregate. The six-scenario qualification is separate
mechanism evidence and is not part of the twenty-task score.
