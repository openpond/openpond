The app should be run with `pnpm dev` for local testing. If an app is already running, you do not need to start another one from the terminal.

Keep files and folders organized for maintainability. Split large components, utilities, and modules into focused files before they become difficult to work with; avoid letting the codebase drift into oversized 2,000-line files that are hard to review, test, and change.

This app is a heavy WIP, optimize for new features, do not worry about supporting legacy or fallback code branches unless explicitly asked

NO Cutting corners or stopping with an MVP, every feature should be fully thought out and coded when prompted

Tests are a deliberate risk-control tool, not an automatic companion to every code change. Add or keep a test when it protects a durable public contract, security or data boundary, concurrency/lifecycle invariant, non-trivial algorithm, or a small number of representative end-to-end paths. Prefer one strong boundary test over parallel unit, projection, registry, prompt-copy, and UI-markup tests for the same behavior. Do not add tests whose main assertion is exact prose, CSS classes, icon names, registry ordering, trivial selectors, or implementation wiring already covered by typechecking, builds, or a stronger boundary test. Every new test should have a short, understandable failure story: what meaningful regression it catches and why existing coverage would miss it.
