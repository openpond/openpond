# Skill Package Layout and Discovery

Use the smallest package that fully captures the reusable procedure.

```text
skills/<skill-name>/
  SKILL.md
  references/
  scripts/
  assets/
```

Only `SKILL.md` is required. Add other directories only when they carry real behavior.

## Frontmatter

`SKILL.md` starts with:

```yaml
---
name: lowercase-kebab-case
description: What the skill does and the concrete requests that should load it.
---
```

Use only `name` and `description`. The description is the discovery contract: include actions, artifact types, and recognizable user intent without becoming a long workflow.

## Main Body

Write imperative instructions for the model. Put the default workflow and completion bar in `SKILL.md`. Keep stable technical detail, variants, or large examples in references and link them from the exact decision point where they are needed.

## Optional Resources

- `references/`: detailed instructions intended for model context.
- `scripts/`: deterministic utilities. Scripts should validate, transform, or inspect bounded inputs; they should not hide the whole reasoning workflow.
- `assets/`: templates or files intended to be copied into outputs rather than read as instructions.

All relative links must stay inside the package and resolve to files. Avoid duplicate guidance across the main file and references.
