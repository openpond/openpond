---
name: openpond-data-and-learning
description: Author OpenPond datasets and checked graders, import supplied examples, or inspect and configure an explicitly requested continual-learning policy.
---

Inspect connection context, the exact Dataset/Model and relevant releases first. For supplied text use `learning_preview_intake` before import; retain its content hash and the canonical import operation identity. For a one-off task use `datasets_add_task` with a stable operation ID. Inspect existing schemas and provenance; preserve train, validation and holdout isolation. A stack trace is diagnostic evidence, not a correct target answer or a verified recovery.

Use the retained grader draft → check → check-result → checked-publication path. Dataset append, training-review submission, admission, release and training are distinct states. Read retained evidence and report the actual state; neither an appended task nor a successful grade starts training.

For a requested policy, inspect the Model's current source/bindings, graders, schedule/timezone, review rules, budgets and held-out evaluation. Save only explicit settings through `training_save_learning_policy` or a schema-supported learning operation. A policy can authorize future paid work within its bounds; saving/enabling needs the user's requested schedule and limits. Distinguish pausing future cycles, stopping an existing cycle and candidate review. Candidate acceptance does not activate serving.

For “send my application's error logs to this Dataset”, inspect the repository only through the agent's available local tools. Follow [the maintained setup guide](https://openpond.ai/agent-setup.md), reuse its logger and SDK, and preserve stable source event identities. Configure credentials through the approved secret workflow. Learning-source keys do not authorize ordinary Dataset task append; do not embed an owner key or chat OAuth token to work around that gap. If the deployed service has no narrowly scoped producer credential for that endpoint, explain the missing contract and stop before enabling ongoing collection. A one-off MCP import does not establish future delivery after this chat closes. Keep Fix-it tool capture separate from arbitrary application log ingestion.

Read policy/source/admission/cycle state and retained candidate evaluation before proposing the next action. Do not infer a paid launch, automatic Dataset enrollment, delivery durability or measured model improvement from configuration alone.
