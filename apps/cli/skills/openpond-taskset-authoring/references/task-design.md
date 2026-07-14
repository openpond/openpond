# Task design

- Define the work from the starting state available to the policy, not from the original chat's hidden future.
- Preserve a source-cluster key for semantically related examples. One cluster may appear in exactly one split.
- Frozen evaluation examples may never be used as demonstrations, prompt exemplars, repair context, or judge calibration data.
- Store transformed task inputs and content-addressed source references. Do not place raw unrelated chats in a Taskset.
- Treat source conversations as evidence. Select only successful, context-complete outcomes; reject stale or contradictory answers and label every repaired or synthetic example.
- Separate stable behavior from changing facts before selecting a training method. A repeated subject is not automatically a repeated learnable job.
- Stateful tasks declare create/reset/step/grade/cleanup, timeouts, deterministic seeds when possible, tool scopes, and network policy.
- A Taskset can target chat, one agent, multiple agents, or a custom harness. Do not force it into an Agent SDK project.
- Write names and objectives for the person reviewing the Taskset. Describe the capability and outcome, not its storage or evaluation machinery.
- Keep source IDs, hashes, cluster keys, split rules, privileged targets, encodings, and grader mechanics out of user-facing names and objectives.
- Mark synthetic fixed-output smoke cases as diagnostics and prefer `no_training`; do not present them as discovered organizational workflows.
