# Copying and Adaptation

A request to copy or adapt an existing Skill is an evidence task before it is a writing task.

1. Resolve the explicit source exactly; do not search for a similarly named substitute.
2. Inventory the source package recursively without following symlinks outside it.
3. Read `SKILL.md`, invocation metadata, every file linked from the main instructions, and every script or asset whose role affects behavior.
4. Record the source package structure before writing the target.
5. Decide which content is invariant and which content must change for the selected Profile.
6. Copy or rewrite the complete relevant package. Preserve relative link topology.
7. Search the target for stale source names, paths, environment assumptions, and broken references.
8. Compare source and target inventories and explain deliberate omissions.

Do not reduce a multi-file source package to a generic `SKILL.md`. Do not silently omit references, scripts, assets, or metadata because they were not visible in the first file read.

When a source file is unsafe, secret-bearing, generated, or irrelevant, omit it deliberately and state why. Never copy credentials, caches, build output, or version-control internals.
