---
name: openpond
description: Entry point for OpenPond CLI, dataset, Agent, skill, and Refiner authoring workflows in this source repository.
---

# OpenPond skills

The maintained customer skills live in `skills/`. Desktop ships these five enabled by default; do not install a second copy inside Desktop.

- [CLI operations](skills/openpond-cli/SKILL.md)
- [Taskset authoring](skills/openpond-taskset-authoring/SKILL.md)
- [Agent authoring](skills/openpond-agent-authoring/SKILL.md)
- [Skill authoring](skills/openpond-skill-authoring/SKILL.md)
- [Refiner authoring](skills/openpond-refiner-authoring/SKILL.md)

For an external coding agent, follow the canonical [agent setup guide](https://openpond.ai/agent-setup.md). Use the standard Skills CLI and select the intended customer skills explicitly:

```sh
npx skills add openpond/openpond --full-depth --skill openpond-cli --agent codex
```

Replace `codex` with the intended supported client, such as `claude-code` or `cursor`. Installation is project scoped unless `--global` is selected. List first with `npx skills add openpond/openpond --full-depth --list`. Use a GitHub tree URL with a verified release tag or commit for a pinned source.

The npm `openpond` release contains the same customer sources at `dist/skills`, together with a versioned SHA-256 manifest and MIT license. `pnpm run skills:package` creates this pack; `pnpm run skills:check` verifies it against the maintained sources. The developer testing skill `openpond-desktop-harness` stays outside the customer pack.

Skills supply workflow instructions. The CLI, SDK, and supported app tools perform operations. Installing a skill does not establish authentication, tool connectivity, or successful execution.
