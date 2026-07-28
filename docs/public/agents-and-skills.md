# Agents and Skills

OpenPond agents and skills start local by default. When you create one from chat, OpenPond writes ordinary source files into the active profile repository, keeps them Git-backed, and updates the profile catalog so Desktop, CLI, TUI, and local chats can discover them.

## Choose the Right Package

| Use | Choose | Why |
| --- | --- | --- |
| Reusable instructions, checklists, references, or a focused workflow | Skill | A profile skill is intentionally a small package centered on one `SKILL.md`; loading it supplies context but does not execute its supporting files. |
| Code, actions, tools, scripts, fixtures, evals, setup requirements, or a durable runtime | Agent | An agent is a full source package with an explicit action and validation surface. |

Agents can call tools, coordinate subagents, run goal loops, expose actions, and move between local and hosted execution without becoming hidden chat state. Skills give any compatible agent a reusable procedure without duplicating that procedure in every prompt.

## Profile Layout

A profile repository can contain multiple named profiles, agents, skills, and Tasksets. A generated agent package commonly looks like this:

```text
openpond-profile.json
profiles/
  default/
    settings/
      profile.yaml
    agents/
      customer-support-tracker/
        package.json
        agent/
          agent.ts
          actions.ts
          instructions.md
          workflows/
            chat.ts
          evals/
            basic.eval.ts
        .openpond/
          agent-manifest.json
          action-registry.json
          agent-inspect.json
    skills/
      release-notes/
        SKILL.md
    tasksets/
      support-triage/
        taskset.json
```

`openpond-profile.json` registers profiles and enabled agents. Each profile's `settings/profile.yaml` controls its catalog and defaults. Agent source, evals, fixtures, and generated OpenPond artifacts belong in the agent package; profile skills live under `skills/<skill-name>/SKILL.md`.

## Agent Lifecycle

From a chat with an editable Profile selected, use:

```text
/agent create <what the Agent should do>
/agent improve <agent-id> <requested change>
```

These commands load OpenPond's bundled Agent-authoring instructions into an ordinary model turn. They do not start Goal mode, create a plan or candidate, open a worktree, or add an Apply step. The model edits the selected Profile source directly and must finish by passing `agent_check`, which runs inspect, build, validate, and eval in order.

The broader lifecycle is:

1. Create an Agent from a useful chat, an Agent SDK template, or an existing repository.
2. Keep instructions, actions, setup requirements, and evals in the generated source package.
3. Inspect, build, validate, and evaluate the package through the Agent SDK.
4. Review the Git diff and commit the source that should become durable.
5. Keep running it locally, or sync the profile repository when hosted execution or sharing is useful.

Chat-driven edits should end as source and tests. The conversation explains why the change was made; the repository records what the agent actually does.

## Skill Lifecycle

Skills are discovered from the active profile and made available to compatible local turns. A skill package may include supporting references, templates, or scripts, but selecting or loading the skill only supplies its instructions and resources; OpenPond does not auto-run those files. Create a skill when the behavior can be expressed as a focused procedure. Promote it to an Agent when the model needs callable tools, automatic execution, durable state, fixtures, setup, or evals.

Use `/skill create <objective>` or `/skill edit <skill-name> <change>` in a chat with an editable Profile selected. OpenPond loads its bundled Skill-authoring package into the normal turn; it does not enter Goal mode or run a template generator. Copy and adaptation requests inspect the complete source package—including referenced instructions, scripts, assets, and metadata—before editing the selected Profile. The packaged validator must pass before the turn reports success.

Ordinary requests such as “make a skill for release notes” can discover the same bundled instructions through the normal skill catalog. The server does not switch modes based on natural-language phrase matching.

Profile skill creation and editing are local profile operations. Commit skill changes in the profile repository before syncing them so local and hosted users share an explicit source version.

## Local and Hosted Use

The same profile repository can remain entirely local or sync through OpenPond Git. Sync it when the agent or skill needs to work from OpenPond Web, another computer, a hosted sandbox, Team Chat, Slack, or Microsoft Teams. Hosted execution consumes the same Git-backed source instead of reconstructing behavior from a private chat transcript.

Cloud use is optional. Local creation, editing, discovery, and execution do not require an OpenPond account; profile sync and hosted resources do.

## Related Guides

- [Creating durable agents](creating-agents.md)
- [OpenPond Agent SDK](agent-sdk.md)
- [OpenPond Git](openpond-git.md)
- [Local, Hybrid, and Cloud](local-cloud.md)
