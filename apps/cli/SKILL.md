---
name: openpond
description: Entry skill for OpenPond CLI workflows. Delegates to the reusable openpond-cli skill in this repo.
metadata:
  short-description: OpenPond CLI skill index
---

# OpenPond CLI Skill

Use this root skill as the default entrypoint when importing this repository into agent skill systems.

## Primary reusable skill

- `skills/openpond-cli/SKILL.md`

## Suggested install commands

- `npx add-skill openpondai/openpond --skill openpond-cli`
- `npx add-skill /path/to/openpond --skill openpond-cli`

## What this skill covers

- API key login and auth flows (`openpond login`)
- Repo create/push workflows (`openpond repo create`, `openpond repo push`)
- Deployment watch workflows (`openpond deploy watch`)
- Tool discovery and execution (`openpond tool list`, `openpond tool run`)
- CLI-driven deploy and tool validation loop
