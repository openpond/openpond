# Creating Durable Agents

OpenPond agents are durable when they become owned source code, not just a useful prompt in a chat transcript. A durable agent has git-backed code, a declared action surface, evals, traces, setup requirements, and an edit policy.

## Creation Paths

- From a chat conversation: turn a useful conversation into agent code and keep ownership of the generated source.
- From a template: start with a known Agent SDK scaffold such as `blank-agent`, `customer-reply-agent`, or `integration-heavy-agent`.
- From an existing repo: add `openpond.yaml` or Agent SDK source, connect the project, sync it, then create an Agent.
- From the CLI: use cloud-backed prompt creation when you want OpenPond to scaffold from a short intent.

```bash
openpond apps agent create --prompt "Build a daily digest agent"
```

Cloud-backed creation requires OpenPond login. Local template creation and local editing do not.

## What Gets Created

A durable agent should include:

- Source files under `agent/` and `src/`.
- A default chat/action entrypoint.
- Instructions and skills that describe behavior in reviewable text.
- Setup declarations for integrations, env vars, secrets, volumes, and schedules.
- Evals that prove important behavior.
- Generated `.openpond/` artifacts for platform consumption.
- An edit policy that describes what Builder Chat may change and what checks are required.

## Recommended Flow

1. Start local.
2. Create or generate the Agent SDK project.
3. Run inspect, build, validate, and eval.
4. Commit the agent source.
5. Connect to an OpenPond Project only when you want cloud sync or hosted execution.
6. Run in an OpenPond Sandbox when you need cloud dependencies, handoff, replay, or durable cloud state.

This keeps the user in control of the source while still allowing the agent to move into hosted infrastructure when that is useful.

## Editing After Creation

Edits should preserve the durable contract:

- Change source first.
- Regenerate artifacts.
- Run required checks.
- Review the git diff.
- Preserve or promote cloud source only after the local or Sandbox result is understood.

When a chat-driven edit is useful, the result should become code and tests, not just a hidden transcript state.
