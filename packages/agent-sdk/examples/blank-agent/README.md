# Blank Agent Example

This is the smallest source-backed OpenPond agent scaffold. It proves the raw-agent path without a copied template.

```text
agent/instructions.md
agent/agent.ts
agent/actions.ts
agent/workflows/chat.ts
agent/channels/openpond-chat.ts
agent/evals/basic.eval.ts
agent/editable.ts
```

## Setup Slots

No external integration, env/secret, schedule, or volume setup is required. The only enabled surface is OpenPond Chat through `agent/channels/openpond-chat.ts`.

## Local Commands

```bash
pnpm agent:inspect
pnpm agent:build
pnpm agent:validate
pnpm agent:eval
openpond-agent run chat --input '{"prompt":"hello","channel":"openpond_chat"}'
```

Generated outputs:

- `.openpond/agent-inspect.json`
- `.openpond/agent-manifest.json`
- `.openpond/action-registry.json`
- `.openpond/artifact-index.json`
- `.openpond/eval-results.json`
- `.openpond/traces/*.jsonl`

This pilot proves the minimal happy path: markdown instructions, markdown skill, chat action, intent router, one eval, edit policy, generated runtime bridge, trace artifact, and no external setup.
