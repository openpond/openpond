# Controlled benchmarks

- Treat a benchmark as a released Taskset plus a pinned comparison protocol,
  not as a training method or a catalog shortcut.
- Infer whether the user wants ordinary frozen evaluation or a repeatable
  baseline/candidate comparison. A Taskset may contain frozen-evaluation cases
  without becoming a benchmark.
- State the claim before authoring cases. Define the primary metric and a hard
  quality gate so efficiency gains cannot hide outcome regressions.
- Isolate adaptation evidence from held-out evaluation by source cluster.
  Neither the candidate author nor its repair context may inspect held-out
  prompts, expected outcomes, grader decisions, or attempt results.
- Pin the Taskset release, policy or Harness releases, model identity,
  reasoning effort, runtime and version, tools, limits, seeds, repetitions,
  sampling, graders, and environment. Refuse a paired conclusion when these
  differ between baseline and candidate.
- Author cases from the user's requested capability and approved evidence.
  Do not silently install a repository-owned reference suite or generate cases
  from a hardcoded benchmark name.
- Keep reusable reference suites content-addressed. A host may ship one as a
  read-only built-in Taskset that appears automatically; do not copy its cases
  into a newly authored benchmark or present it as an authoring template.
- Validate case realism, split isolation, grader calibration, solvability,
  runtime conformance, and receipt completeness before publishing a result.
- Materializing or running a benchmark never starts training. Training remains
  a separate, explicit decision based on the resulting evidence.
