# Harness Refiner Benchmark

This benchmark asks one question:

> Given concrete evidence of an avoidable failure, can Refiner produce a
> general Harness improvement that increases held-out success or efficiency
> with the same model, effort, runtime, and tools?

The first experiment prioritizes foreground token savings. Quality is a hard
non-regression gate: using fewer tokens does not count as an improvement when
the result stops satisfying the task.

## Experiment

The canonical benchmark is a versioned `@openpond/evals` Taskset with twenty
natural, real-world requests:

- ten visible adaptation cases that may produce evidence for Refiner;
- ten distinct frozen-evaluation cases that Refiner cannot inspect;
- artifact, research, and everyday-work tasks written as ordinary user
  requests, without benchmark, tool, or workspace instructions;
- shared behavioral-family tags, with separate source clusters across the two
  splits.

The social-research case studies recent public ChatGPT experiences on X and
Reddit. It must include both positive and negative observations, distinguish
recurring patterns from anecdotes, and state platform-access and sampling
limitations. It does not post, react, or interact with accounts.

The detailed split and acceptance contract are in the
[Taskset design](./taskset/README.md). The materialized
[`harness-refiner-08112026` Taskset Release](./taskset/taskset.release.json)
contains the frozen prompts, fixtures, grader assets, and production-derived
tool contracts. The 08112026 release includes four fact-distinct
direct-deliverable tasks in each split so repeated checklist-or-file
substitution is visible across sequential adaptation, and calibrates the judge
to accept short framing when the complete requested copy is present inline.
Its current content hash is
`4cef91a9c92df39d16f741b4d901dbde6b62e72bd8a48647a4a81c0d517d9634`.

## Shipped reference Taskset

This repository-owned suite ships with OpenPond as a built-in, read-only
Taskset. The app server ensures it is present for each Profile, so it appears in
Cases, Scoring, and History without an installation button or CLI command.
Running it records normal Taskset Evaluation receipts but never modifies its
prompts, graders, split, or pinned protocol.

User-authored benchmarks remain separate and follow the ordinary Taskset-authoring workflow. Their
cases and protocol come from the requested claim and approved evidence rather
than from the Harness Refiner suite.

## Reproduce the Taskset

From the OpenPond repository root:

```bash
pnpm benchmark:harness-refiner:build
pnpm benchmark:harness-refiner:check
```

The build command regenerates the immutable release from the public case
source, fixtures, rubric, verifier, and current production tool definitions.
The check command rebuilds it in memory, rejects checked-in drift, validates
all content and asset hashes, checks split isolation and family balance, and
ensures prompts contain no Harness or benchmark instructions.

These commands create and validate an Evaluation Taskset only. They do not run
the cases, call a model, update a Harness, or start training.

## Controlled comparison

Each complete pass uses the following sequence:

1. Run the frozen-evaluation cases with the baseline Harness and Refiner off.
2. Run the adaptation cases with the same baseline Harness.
3. Run the same ordered adaptation tasks once in an isolated treatment
   workspace. After each task settles and is graded, invoke the real product
   Refiner boundary. The next distinct task uses the resulting immutable
   Harness release. Frozen-evaluation prompts, labels, and results are never
   included in Refiner context.
4. Freeze the final treatment Harness and its complete step-by-step lineage.
5. Run the frozen-evaluation cases with the final Harness using the same
   content-addressed web-evidence snapshot as the baseline.
6. Compare paired held-out results. Repeat the full pass once after the protocol works
   end to end.

The baseline and candidate Run Manifests must pin the same model identity,
reasoning effort, runtime adapter and version, tool declarations, limits, and
Taskset Release. For `openpond-chat`, the receipt must retain both the stable
alias and the current upstream identity, DeepSeek V4 Pro.

The canonical runner uses OpenPond Desktop's local Work runtime. Every attempt
gets an isolated managed local directory with the standard
`/workspace/inputs`, `/workspace/work`, and `/workspace/outputs` contract. It
does not provision a hosted Sandbox or a Latitude lease. Hosted Taskset
Evaluation is a separate deployment qualification and is not interchangeable
benchmark evidence.

## Metrics

The primary metric is paired foreground provider tokens on held-out cases.
Reports also retain:

- task and grader pass/fail receipts;
- prompt, completion, and total foreground tokens;
- Refiner background tokens and amortized net savings;
- tool calls, tool failures, duration, and terminal state;
- baseline and candidate Harness hashes and exact diffs;
- Refiner decisions, evidence references, validation, and apply receipts.

Success must not regress. Infrastructure failures, timeouts, partial runs, or
an unchanged Harness are reported but cannot support an improvement claim.

## Results

No result is published yet. Earlier diagnostic runs replayed the same cases,
did not provide Refiner with the final grader evidence, and did not produce a
candidate Harness Release. They are development evidence, not benchmark
results.

When a clean pass exists, a public Sandbox benchmark page can summarize the
paired metrics and link back to the exact Taskset Release, Run Manifests, and
redacted receipts in this directory. The public page must not replace these
content-addressed source artifacts.
