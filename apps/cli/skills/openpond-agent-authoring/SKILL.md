---
name: openpond-agent-authoring
description: Create, improve, review, or repair source-backed OpenPond Profile Agents. Use for /agent create or improve, Make Agent, Improve Agent, and ordinary requests to build or change an Agent SDK project.
---

# OpenPond Agent Authoring

Create durable Agent source through a normal model turn. Do not create a Goal, Create/Improve run, plan/candidate lifecycle, worktree, or Apply step.

## Execution interface

Inside OpenPond, use the Profile and Agent tools named below. In an external coding agent, first inspect `openpond profile current --json` and use its selected `sourcePath` as the Profile root. If no editable source is selected, request the intended source location or use `openpond profile load --path <repository>` only within the user's setup scope. Do not guess an app-data path.

Map `agent_inspect`, `agent_build`, `agent_validate`, `agent_eval`, and `agent_traces` to `openpond agent inspect|build|validate|eval|traces --cwd <agent-package> --json`. Run inspect, build, validate, then eval in order for the final check; there is no `openpond agent check` command. Read the installed command help and the package's SDK configuration before executing evals or actions; provider-backed behavior needs the user's execution scope and budget. `openpond profile catalog --json` refreshes the source view. Ordinary clarification uses the client's question mechanism.

## Workflow

1. Resolve the selected Profile through the execution interface above (`get_profile` in OpenPond). Use only its selected, editable Profile root and the exact target Agent ID carried by the authoring intent.
2. Inspect nearby Agent packages and the target Agent when improving one. Read relevant Profile settings and registration before editing.
3. Ask one focused `ask_user` question only when a missing answer would materially change actions, behavior, integrations, setup, or output contracts.
4. Create or edit the Agent SDK package directly beneath the selected Profile, normally `agents/<agent-id>`.
5. Preserve unrelated dirty files and other Agents.
6. Design the instructions, chat behavior, direct actions, schemas, integrations, setup requirements, evals, and user-facing documentation as one coherent Agent.
7. Use `agent_inspect`, `agent_build`, `agent_validate`, `agent_eval`, `agent_run`, and `agent_traces` for SDK behavior. Do not hide SDK execution behind raw shell fragments.
8. Run `agent_check` in OpenPond, or the four CLI checks above externally. Repair the first failure and rerun until the complete check passes.
9. Refresh and inspect the Profile catalog, then report changed files, public actions, check receipts, and any genuine blocker.

Read [Profile and Agent layout](references/profile-layout.md) before creating or relocating source. Read [action and chat design](references/action-and-chat-design.md) while defining behavior. Read [integrations and setup](references/integrations-and-setup.md) when the Agent touches external systems. Read [validation and repair](references/validation-and-repair.md) before completion.

## Authoring Rules

- Use an actual `openpond-agent-sdk` project with `package.json`, TypeScript configuration where needed, `agent/agent.ts`, deterministic evals, and generated `.openpond` artifacts.
- Actions are the public runtime surface. Give every Agent a useful default `chat` action unless the requested product explicitly cannot chat.
- Keep declaration-time source deterministic. Do not read secrets, call providers, or create infrastructure while importing `agent/agent.ts`.
- Use setup requirements and connection declarations for credentials; never embed secrets.
- Prefer typed schemas and stable action IDs. Keep implementation details behind actions.
- Treat generated `.openpond` files as SDK outputs, not hand-authored source.
- During improve, reject a missing, stale, disabled, or different-Profile target rather than editing a fallback Agent.

## Safety and Completion

- Never reset, clean, commit, push, sync, publish, or promote automatically.
- Never create Goal state, a hidden execution session, a candidate, or plan approval.
- `agent_*` tools inspect, run, and validate; they do not own the authoring objective or write the Agent.
- Do not weaken validation or evals to make checks pass.
- Do not report success until the supported complete check passes against the active edited source.
