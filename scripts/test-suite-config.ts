export const ROOT_INTEGRATION_TESTS = [
  "tests/training-local-cpu-fixture.test.ts",
  "tests/training-start-orchestration.test.ts",
] as const;

export const CLI_INTEGRATION_TESTS = [
  "test/cli-headless-chat.test.ts",
  "test/cli-project-agent-sandbox.test.ts",
] as const;

export const CLI_RELEASE_TESTS = ["test/cli-installed-smoke.test.ts"] as const;

export type PrimaryTestSuite = "unit" | "integration" | "contract" | "release" | "live";
export type TestSuite = PrimaryTestSuite | "all" | "cli" | "agent-sdk";

export const ALL_TEST_SUITES: readonly PrimaryTestSuite[] = [
  "unit",
  "integration",
  "contract",
  "release",
];
