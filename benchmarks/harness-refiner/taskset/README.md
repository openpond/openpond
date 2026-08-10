# Harness Refiner Taskset Design

Status: Taskset Release materialized; model-judge calibration and runtime
conformance pending.

This directory contains the canonical `openpond.tasksetRelease.v2` used by the
Harness Refiner benchmark. Benchmarking is a first-class Taskset purpose: the
same portable cases, assets, graders, and receipts appear in the Tasksets UI,
while the benchmark protocol controls paired execution and comparison. Running
this benchmark does not start a training job.

- Release: [`taskset.release.json`](./taskset.release.json)
- Release id: `harness-refiner-public-v1`
- Revision: `1`
- Content hash:
  `1f85a2804e289e63038081d32be5576a1c5342d163c9721cbb4bf6ae6c8f0695`
- Rebuild: `pnpm exec tsx benchmarks/harness-refiner/taskset/build.ts`

## Split

All twenty prompts must read like real requests from a person using an agent.
They must not name Refiner, Harness internals, benchmark paths, tool names, or
workspace layout.

| Family | Adaptation cases | Frozen-evaluation cases |
| --- | ---: | ---: |
| Artifact creation and verification | 4 | 4 |
| Current or primary-source research | 4 | 4 |
| Constraint-following everyday work | 2 | 2 |
| Total | 10 | 10 |

Adaptation and frozen-evaluation cases may share a behavioral-family tag, such
as `artifact-verification` or `research-efficiency`, but may not share a source
document, expected answer, entity set, or source-cluster key.

## Case families

The first release should cover these general behaviors across different
subjects in each split:

- produce a bounded PDF from a supplied decision packet and visually verify it;
- produce a bounded PDF from a supplied incident or operations packet without
  collapsing confirmed facts and open hypotheses;
- create and verify a structured spreadsheet or presentation artifact;
- preserve dates, owners, local times, and unresolved gates in an executive
  handoff;
- audit a software stack using primary security advisories without inferring
  exposure from an advisory alone;
- compare primary research papers without converting incomparable metrics into
  a leaderboard;
- verify a time-sensitive travel or accessibility plan from official evidence;
- find eligible time-sensitive funding opportunities without padding the list;
- summarize recent public ChatGPT experiences from X and Reddit with direct
  links, dates, balanced evidence, and sampling limitations;
- complete a concise everyday communication task without inventing facts.

The held-out split uses different documents, organizations, routes, software,
papers, and communication scenarios while preserving the same reusable failure
classes.

## Evidence contract

Each attempt must retain the visible request and answer, runtime and tool
receipts, generated artifacts, deterministic checks, calibrated grader output,
manual-review state where required, and authoritative provider usage.

For adaptation cases, Refiner receives bounded neutral facts,
content-addressed references, the final grader receipt, and that case's bounded
expected-output contract after grading. These are the visible learning labels
for the adaptation split. The model decides relevance and the smallest
justified Harness change. Deterministic code enforces authorization, budgets,
schemas, paths, hashes, validation, atomic application, and rollback; it does
not choose the semantic diagnosis or route.

Frozen-evaluation prompts, privileged expected outcomes, grader rubrics, and
results remain unavailable to Refiner until the candidate Harness is frozen.

## Materialization and execution gate

The checked-in release now satisfies these materialization requirements:

- all twenty prompts and split assignments are frozen;
- every fixture and rubric has an immutable asset reference and content hash;
- production tool declarations and capability requirements are captured from
  the qualified runtime rather than rewritten by hand;
- the deterministic verifier and model judge are declared with immutable
  assets;
- `@openpond/evals` validates the release and rejects split-cluster
  contamination;

The model judge remains explicitly `pending` until it is calibrated. Before a
benchmark result can be published, one conformance run must prove the Taskset,
Harness, runtime, grader, artifact, and receipt path end to end without invoking
training.
