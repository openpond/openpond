# CLI Reference

The package binary is `openpond-agent`.

## Commands

```bash
openpond-agent init blank-agent --cwd ./my-agent
openpond-agent inspect --json --cwd ./my-agent
openpond-agent build --cwd ./my-agent
openpond-agent validate --json --cwd ./my-agent
openpond-agent eval --json --cwd ./my-agent
openpond-agent run chat --cwd ./my-agent --input '{"prompt":"hello","channel":"openpond_chat"}'
openpond-agent traces --json --cwd ./my-agent
```

Every command accepts `--cwd <project>`. Artifact-producing commands accept `--out-dir <dir>` and default to `.openpond`.

## Command Roles

- `init`: copies a packaged template.
- `inspect --json`: emits normalized source/project/action/setup/editable metadata for source-edit checks, web, app, and publish flows.
- `build`: writes deterministic `.openpond` artifacts, runtime manifest preview, action registry, runtime bridge, prompt artifacts, validator report, and artifact index.
- `validate`: checks source layout, source-of-truth mode, channels, integrations, schedules, intents, workflows, tools, eval declarations, env/secrets, volumes, instructions, skills, editable policy, and secret leakage.
- `eval`: runs source-defined evals through the local runtime runner and writes eval/trace artifacts.
- `run <action>`: runs one local action through the runtime runner and writes a trace artifact.
- `traces`: lists trace JSONL artifacts.

The main OpenPond CLI can delegate `openpond agent inspect|build|validate|eval|run` to this project-local binary.
