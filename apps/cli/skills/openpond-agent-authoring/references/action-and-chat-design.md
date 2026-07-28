# Action and Chat Design

Actions are the public runtime surface.

- Provide a `chat` action for natural-language ingress unless the product is deliberately direct-action-only.
- Give actions stable, descriptive IDs and typed input/output schemas.
- Keep orchestration, tools, workflows, and subordinate agents behind actions.
- Use a deterministic intent router when multiple conversational behaviors exist.
- Put durable behavioral guidance in source-controlled instructions rather than runtime-only prompt strings.
- Make failure states explicit and user-facing.
- Add evals for the most important action contracts, ambiguous routing, unsafe input, and regressions introduced by the requested change.

Design the full experience: setup, action labels, schemas, response shape, artifacts, traces, and documentation should agree. A large prompt in `agent/agent.ts` without actions, checks, or evals is not a complete Agent.
