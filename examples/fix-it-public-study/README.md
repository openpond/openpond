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
The execution protocol also retains hashes of the exact asset manifest and
per-file verification receipt.

The bounded baseline/source collector is available for development and correction
partitions. Prepare its exact protocol before inference:

```sh
uv run fixit-study run-baseline \
  --plan ./results/development-smoke-plan.json \
  --confirm-plan-sha256 REPLACE_WITH_PRINTED_PLAN_SHA256 \
  --data-dir ./data --max-spend 20 \
  --output ./results/development-smoke --prepare-only
```

Review the saved `protocol.json`, including the chosen spending ceiling, model
snapshots, generation caps, package/asset identities and rates. To execute that
same protocol, repeat the command without `--prepare-only` and add
`--confirm-protocol-sha256 REPLACE_WITH_PRINTED_PROTOCOL_HASH`. The example $20
ceiling is a preparation input, not an estimate or spending authorization. The
upstream provider reads its ordinary OpenAI API credential; the study contains
no login helper or account credential. The prepared protocol and its limit
cannot change when resuming a run.

Each request first reserves the price of the documented model's entire context
window plus its capped output. This is deliberately more conservative than a
local token estimate. The reservation is released only after actual usage is
retained. For GPT-5.5 with the default 4,096 output cap, one reservation is
$10.68432; that is headroom, not the expected charge. A $20 run stops when it
cannot fund another such reservation, even if its current token expense is
below $20. Unknown responses block new requests across process restarts.
Automatic provider and episode retries are disabled. The SQLite ledger retains
caller, simulator and official judging calls, tokens and calculated token cost;
these calculations are separate from a posted provider invoice. Prompt-cache
usage is charged at its frozen rate; local response caching is disabled.

The collector uses the upstream orchestrator, ordinary tools, English bindings
and official evaluator. It records both initial database hashes, actual tool
arguments/results, typed tool failures, wall time and scored/unscored outcomes.
It does not alter tool inputs or manufacture errors. Only the twelve declared
correction-source tasks can emit review candidates. A later same-tool success
is an **unverified review lead**, never an approved target or a training claim.
Unresolved failures remain visible. Full task success and correct recovery
attribution still need review.
Each assistant tool attempt also references the caller's actual visible message
history and ordinary tool schemas at that moment. These support grounded review
and later consultation; simulator-only instructions, task answers and evaluator
state are never read into this context.

Held-out test plans are refused by this baseline collection command. The SDK
consultation adapter, frozen learned-checkpoint comparison, reviewed public
corpus and interleaved A/B/C execution remain in progress. No effectiveness or
savings result exists yet. The final comparison must retain failed and
non-triggering tasks, all simulator/judge/consultation costs, the exact qualified
specialist and normal tool permissions. Evaluation answers and failed test
traces must never enter adaptation or model-visible context.

The focused spending-boundary check uses the real pinned provider serialization
with a replaced HTTP transport. It verifies the outgoing output cap, absence of
hidden retries, durable uncertainty and denial before dispatch when unfunded:

```sh
uv run --locked python -m unittest discover -s tests
```

Sources: [upstream benchmark runner](https://github.com/sierra-research/tau2-bench/blob/v2.0.0/docs/running-the-benchmark.md),
[OpenAI prices](https://developers.openai.com/api/docs/pricing),
[GPT-5.5 bounds](https://developers.openai.com/api/docs/models/gpt-5.5),
[GPT-5.4 Mini bounds](https://developers.openai.com/api/docs/models/gpt-5.4-mini).
