# Customer Reply Agent Example

This small template proves copied source ergonomics for a common first-party agent.

It supports OpenPond Chat by default and declares optional Slack capability in source without storing connection IDs or secrets.

## Setup Slots

- OpenPond Chat is the default local channel.
- Slack is optional and disabled until the platform selects the channel and binds a Slack connection.
- No env/secret or volume setup is required.

## Prompt Authoring

This pilot intentionally uses TypeScript-generated instructions and a TypeScript-generated skill package:

- `agent/instructions.ts`
- `agent/skills/reply-style.ts`

Blank-agent remains the markdown-only pilot.

## Local Commands

```bash
pnpm agent:inspect
pnpm agent:build
pnpm agent:validate
pnpm agent:eval
openpond-agent run chat --input '{"prompt":"Draft a reply","channel":"openpond_chat"}'
```

Generated outputs:

- `.openpond/prompts/instructions.md`
- `.openpond/skills/reply-style/SKILL.md`
- `.openpond/skills/reply-style/references/tone.md`
- `.openpond/eval-results.json`
- `.openpond/traces/*.jsonl`

This pilot proves the small template path: copied source, generated prompts, optional Slack channel requirements, local action run, eval output, trace artifact, and edit policy.
