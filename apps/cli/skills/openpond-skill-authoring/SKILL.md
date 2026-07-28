---
name: openpond-skill-authoring
description: Create, copy, adapt, review, or update OpenPond Profile skill packages. Use for /skill create or edit and for ordinary requests to make or improve a reusable SKILL.md workflow with optional references, scripts, assets, and metadata.
---

# OpenPond Skill Authoring

Create durable Profile skills through a normal model turn. The skill package is the source of truth; do not create a Goal, invoke an authoring executor, or substitute a generic template for source that the user asked to copy or adapt.

## Workflow

1. Call `get_profile` before reading or writing Profile source. Use only its selected, editable Profile root.
2. Determine whether the request is create, edit, copy, or adapt. Treat an explicit skill name or source path as target authority.
3. Inspect nearby Profile skills for local conventions.
4. When an existing source package is named, inventory and read its complete relevant package: `SKILL.md`, referenced files, scripts, assets, and metadata. Do not infer its behavior from the directory name.
5. Ask one focused `ask_user` question only if a missing answer would materially change the reusable behavior or package boundary. Otherwise proceed.
6. Create or edit `<profile source>/skills/<skill-name>` directly with ordinary scoped file tools.
7. Run the packaged validator:

   `node <this bundled skill package>/scripts/validate-skill.mjs <target skill package>`

8. Repair every validation failure in scope and rerun until it passes.
9. Report the target package, files created or changed, preserved source resources, validation receipt, and any genuine blocker.

## Package Rules

- Every package has `SKILL.md` with YAML frontmatter containing only `name` and `description`.
- Use lowercase kebab-case for the package directory and frontmatter `name`; they must match.
- Put triggering conditions in `description`, not in a separate discovery section.
- Keep `SKILL.md` concise. Move detailed knowledge to focused files under `references/`.
- Put deterministic utilities under `scripts/` and output templates or reusable media under `assets/`.
- Use relative Markdown links for files the model must load. Resolve every link before completion.
- Preserve useful source structure and behavior during copy/adapt requests. Change names, paths, or Profile-specific instructions only where required.
- Do not add a script when clear instructions suffice, and do not add a tool dependency for work ordinary file or command capabilities can perform.

Read [package layout and discovery](references/skill-package-layout.md) when creating a package. Read [copying and adaptation](references/copying-and-adaptation.md) whenever the request names existing source. Read [validation and repair](references/validation-and-repair.md) before declaring completion.

## Safety and Completion

- Preserve unrelated dirty files and never reset, clean, commit, push, or sync automatically.
- Never write outside the selected Profile unless the user explicitly supplied a read-only source package to copy from.
- Never create Goal state, `thread_goal` events, a plan/candidate lifecycle, or an Apply step.
- The validator inspects only. It must never generate or rewrite the target.
- Do not report success until the target was actually inspected after writing and validation passed.
