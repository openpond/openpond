# Fix-it public effectiveness and cost study

This custom study uses 20 held-out English tasks from tau-bench 2.0.0's released
text-v1 frame. Six development tasks and twelve correction-source tasks are
disjoint. The selection is fixed before model outputs; keep failures and tasks
without eligible tool errors in the denominator. This is not a leaderboard run.

The current command resolves and validates the selected tasks and released
English asset bindings without inference or scoring:

```sh
uv sync --locked
uv run fixit-study fetch-data --data-dir ./data
uv run fixit-study plan --split development-smoke \
  --data-dir ./data \
  --agent-model openai/gpt-5.5 --agent-args '{"reasoning_effort":"low"}' \
  --user-model openai/gpt-5.5 --user-args '{"reasoning_effort":"low"}' \
  --output ./results/development-smoke-plan.json
```

These model names are explicit planning inputs, not a paid-run authorization or
a frozen final model choice. The command requires the exact locked upstream Git
commit and refuses to overwrite retained plans. `--split test` resolves exactly
20 tasks; it does not execute them. The plan retains upstream frame, task and
binding identities. No account, private paths or endpoints are hardcoded.

`fetch-data` downloads the selected domains, language-pack assets needed to
verify the complete released frame, and frozen subset metadata from that
immutable source commit. Execution selection remains English only. Every file is verified
against its pinned Git blob and size, and its SHA256 is retained. Existing
modified files fail verification. Published result trajectories are excluded.

Paid execution, the SDK consultation adapter, reviewed correction collection,
per-call cost caps and the interleaved arm runner are still in progress. Do not
interpret a selection plan as a benchmark result or a savings claim. The final
comparison must retain full-episode outcomes, ordinary tool permissions, naturally
observed structured failures, user-simulator and official grader costs, and the
exact qualified specialist. Evaluation answers and failed test traces must never
enter training or model-visible context.

Upstream: [running the benchmark](https://github.com/sierra-research/tau2-bench/blob/v2.0.0/docs/running-the-benchmark.md).
