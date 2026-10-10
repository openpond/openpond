The app should be run with `pnpm dev` for local testing. If an app is already running, you do not need to start another one from the terminal.

## UI patterns

For a list of selectable values, use the existing `DropdownSelect` (`apps/web/src/components/DropdownSelect.tsx`) or the relevant established picker. Show the selected value in the trigger and the choices in the dropdown; do not just render all the options as an inline list or invent a one-off native select. Collections of saved records still use tables: reuse the existing experiment table layout and shared page styles. Inspect a current rendered screen and match its spacing, typography, controls, and table geometry before calling UI work complete. Keep this guidance here; do not add a separate OpenPond design-system document.

## Development and validation

Use the official OpenPond CLI for supported operations, including experiment preparation, execution, status, results and comparison. Check the CLI help or command reference before creating helper scripts. Do not duplicate existing CLI authentication or API operations in custom scripts; use a custom helper only for a verified capability gap.

Typechecking is selective validation, not a default step after every edit or turn. Do not run a full-repository typecheck for documentation, copy, styling, or small implementation changes without a concrete type-related concern. Prefer existing diagnostics and the smallest relevant package/project check when changing shared types, public interfaces, module boundaries, TypeScript configuration, or investigating a type error. Batch related edits and run the needed check once; repeat only after relevant changes or to verify a fix for a reported failure. Leave routine full-repository checking to CI unless the user requests it or a broad cross-project change needs local validation. Do not run a build merely as a substitute for a skipped typecheck, and state accurately which checks were run or skipped.

For TypeScript validation, use `pnpm run typecheck` or the package's typecheck/build script. For a custom compiler invocation, use `node scripts/run-typescript.mjs tsc <args>` from the repository root instead of invoking `tsc` directly. The runner lowers local priority and serializes Linux compiler runs across OpenPond and Sandbox. Reuse an already-running check rather than starting duplicates. CI runs unrestricted; `TYPECHECK_UNRESTRICTED=1` explicitly opts out locally.

Keep files and folders organized for maintainability. Split large components, utilities, and modules into focused files before they become difficult to work with; avoid letting the codebase drift into oversized 2,000-line files that are hard to review, test, and change.

This app is a heavy WIP, optimize for new features, do not worry about supporting legacy or fallback code branches unless explicitly asked

NO Cutting corners or stopping with an MVP, every feature should be fully thought out and coded when prompted

Tests are a deliberate risk-control tool, not an automatic companion to every code change. Add or keep a test when it protects a durable public contract, security or data boundary, concurrency/lifecycle invariant, non-trivial algorithm, or a small number of representative end-to-end paths. Prefer one strong boundary test over parallel unit, projection, registry, prompt-copy, and UI-markup tests for the same behavior. Do not add tests whose main assertion is exact prose, CSS classes, icon names, registry ordering, trivial selectors, or implementation wiring already covered by typechecking, builds, or a stronger boundary test. Every new test should have a short, understandable failure story: what meaningful regression it catches and why existing coverage would miss it.
