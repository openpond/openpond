# Task design

- Use these terms precisely:
  - a **task** is one executable episode with an instruction, starting state,
    runtime, and success check;
  - a **dataset** is a reusable collection of task records or source data;
  - a **Taskset** is the versioned package that selects those tasks and binds
    their split, verifier, runtime contract, metrics, and provenance;
  - a **run** applies a model to a released Taskset;
  - a **Model** owns the base policy and any trained versions produced by runs.
- Treat the Taskset as a module and release boundary, not as a code-authoring
  burden for the user. Emit a content-addressed bundle that native OpenPond,
  OpenPond Managed workers or a later adapter can load without changing task
  semantics.
- Treat a task as an executable contract, not just a row. Specify the
  policy-facing instruction, initial state, Harness/tools, verifier, task-owned
  evidence, lifecycle, resource limits, network policy, and optional reference
  solution.
- Keep task configuration nested by responsibility: task metadata, policy
  runtime, verifier runtime, environment resources, and artifacts. Do not leak
  infrastructure configuration into the natural-language instruction.
- Declare whether the verifier shares the policy environment or runs in a
  separate private environment. Prefer separate verification when grader code,
  secrets, clean state, or tamper-resistant evidence must remain unavailable to
  the policy.
- Declare the exact artifacts or state transitions the verifier may inspect.
  Treat agent-controlled logs as untrusted unless a private Harness or isolated
  service records them.
- Use a reference solution or oracle when it can sanity-check solvability, but
  never expose it to the student or treat it as mandatory for tasks verified by
  state, tests, or reward.
- Use sequential steps only when later instructions or verification genuinely
  depend on earlier state. Give every step its own instruction, termination,
  verifier evidence, and failure boundary.
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
