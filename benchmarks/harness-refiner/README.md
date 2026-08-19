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
[`harness-refiner-20260818-v2` Taskset Release](./taskset/taskset.release.json)
contains the frozen prompts, fixtures, deterministic grader assets, and
production-derived tool contracts. It includes four fact-distinct
direct-deliverable tasks in each split so repeated checklist-or-file
substitution is visible across sequential adaptation. Its content hash is
`20e247cec268ecb6380bc7af204abc9056f7eaa90e1e85aa5e11544f2506888d`.

## v3 validity follow-up

The sealed v2 result is a systems trace, not a validated quality or continual
learning result. Its deterministic verifier was reproducible but reduced
natural-task quality to hidden lexical and artifact-receipt checks, so v2 pass
counts must not be used as an RL reward baseline or improvement claim.

The in-progress [`harness-refiner-20260819-v3` release](./taskset/releases/harness-refiner-20260819-v3.json)
keeps the same public task corpus while exposing source-traceable criteria,
separating deterministic format/artifact checks from semantic grading, and
recording criterion-level evidence and diagnoses. It is **not admitted for a
paid natural run** until its semantic judge, fixture corpus, metamorphic audit,
and A/A variance plan are calibrated and frozen. Rebuild it with:

```bash
pnpm benchmark:harness-refiner:v3:build
pnpm benchmark:harness-refiner:v3:conformance
```

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
6. Compare paired held-out results under the frozen final Harness.

The baseline and candidate Run Manifests must pin the same model identity,
reasoning effort, runtime adapter and version, tool declarations, limits, and
Taskset Release. The 20260818-v2 controlled run uses OpenPond Chat with
DeepSeek V4 Flash and retains the exact upstream catalog revision and pricing
in its private receipt.

Before execution, `pnpm benchmark:harness-refiner:prepare` creates a fresh
isolated store and a content-addressed admission receipt. It binds the portable
Taskset, its projected application form, the execution-bound Taskset,
Environment and Verifier Set releases, the initial Harness release,
forty-attempt execution plan, model, sampling, reasoning effort, gateway
environment, spend ceiling, 180-second Refiner timeout, 1,200-token Refiner
response limit, and at most two Refiner invocations per adaptation task. A
retry resumes the same foreground attempt and trigger; exhausted retries stop
the run and remain failed evidence.

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

`pnpm benchmark:harness-refiner:audit` verifies the final admission, six-case
qualification, result manifest, evaluation receipt, forty unique stage/task
attempts, twenty canonical pairs, sequential checkpoint, Refiner retries,
spend ceiling, and immutable Harness lineage. It writes a private audit receipt
and the redacted public aggregate from the same terminal evidence.

## Results

The 20260818-v2 controlled run completed all forty foreground attempts and
twenty canonical pairs with valid immutable lineage and an enforced $5 spend
ceiling. It used OpenPond Chat with DeepSeek V4 Flash, cost $0.888575, and used
222,498 Refiner tokens in addition to foreground work.

Refiner returned `no_action` after each of the ten sequential adaptation
tasks, so the baseline and final Harness hashes are identical. One Refiner
invocation failed and was recovered by the admitted same-attempt retry. No
high-confidence reusable Harness change was accepted.

The comparison is therefore **inconclusive**, not evidence of continual
improvement. The baseline passed 5/10 adaptation and 3/10 held-out contracts;
the repeated candidate pass passed 3/10 adaptation and 4/10 held-out
contracts. Total foreground tokens fell from 11,063,871 to 10,728,586, but
because the Harness did not change, neither the pass-count nor token
differences can be attributed to Refiner.

The separate six-scenario qualification passed all six controlled scenarios,
including abstention, routing, bounded mutation with rollback, fact-distinct
transfer, and persisted cross-run review. That establishes mechanism coverage;
it does not turn the natural-task benchmark into a positive result.

The complete redacted aggregate and all twenty task pairs are in the
content-addressed [20260818-v2 public result](./results/harness-refiner-20260818-v2.json).
Its content hash is
`e31311cbf919c65b2059531990b7f345cb1a2a928bfe50e114c39f75726f459c`.

### Historical result

The locked 08112026 run completed all forty planned attempts with valid
provider usage, frozen external evidence, and immutable Harness lineage. One
reusable change was accepted after the ninth adaptation task: return complete
short messages inline instead of only writing a file or returning its path.

That change transferred to the related held-out message family: all four tasks
used fewer tokens, their aggregate fell from 42,866 to 21,823 tokens (49.1%
fewer), and quality rose from 2/4 to 4/4. The broader claim did not pass. Across
all ten held-out tasks, seven used fewer tokens, but three unrelated
artifact/research outliers drove the aggregate from 2,209,073 to 2,998,965
tokens (35.8% more). Overall held-out quality remained 8/10.

The complete redacted aggregate and all twenty task pairs are in the
content-addressed [08112026 public result](./results/harness-refiner-08112026.json).
Earlier incomplete and batch/replay runs remain development evidence and are
not included in the public result.

Historical public result content hash:
`14d622744d9397d415aeda8285b53b7d1c5c5486c45e0e953bb093e714d156b1`.
