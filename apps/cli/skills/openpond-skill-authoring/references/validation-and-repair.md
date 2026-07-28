# Validation and Repair

Run `scripts/validate-skill.mjs` from the bundled `openpond-skill-authoring` package with the target package as its only positional argument.

The validator checks:

- target and `SKILL.md` existence;
- package-boundary and symlink safety;
- YAML frontmatter delimiters and allowed keys;
- matching lowercase kebab-case directory and `name`;
- a meaningful `description`;
- file-size bounds; and
- local Markdown references.

Treat a nonzero exit as unfinished work. Read every diagnostic, repair the package rather than weakening the validator, and rerun it.

Validation does not prove the workflow is useful. Also review:

- whether the discovery description matches realistic user requests;
- whether the main file contains a complete default workflow;
- whether references are loaded only where relevant;
- whether scripts are deterministic and bounded;
- whether copy/adapt work preserved the source behavior; and
- whether the final report names exact changed files and validation evidence.
