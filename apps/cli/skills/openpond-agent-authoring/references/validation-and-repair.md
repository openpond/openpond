# Validation and Repair

Use the first-class Agent tools rather than raw SDK shell commands:

1. `agent_inspect` to confirm discovery, actions, source, and diagnostics.
2. `agent_build` to refresh generated artifacts.
3. `agent_validate` to enforce SDK contracts.
4. `agent_eval` to run deterministic declared evals.
5. `agent_run` and `agent_traces` when behavioral proof or failure diagnosis requires them.
6. `agent_check` as the mandatory final composite receipt.

`agent_check` runs inspect, build, validate, and eval in order and stops at the first failure. Repair the source, not the checker. Rerun until every step passes.

After a pass, inspect changed files and the refreshed Profile action catalog. Confirm that the requested Agent ID is enabled and that unrelated Agents and dirty files are unchanged.
