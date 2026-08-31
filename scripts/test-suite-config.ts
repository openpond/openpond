export {
  ROOT_IMAGE_TESTS,
  ROOT_MEMORY_TESTS,
  ROOT_SYSTEM_TESTS,
  ROOT_UI_TESTS,
} from "./test-suite-manifest";

export const CLI_INTEGRATION_TESTS = [
  "test/cli-headless-chat.test.ts",
  "test/cli-project-agent-sandbox.test.ts",
] as const;

export const CLI_RELEASE_TESTS = ["test/cli-installed-smoke.test.ts"] as const;

export const UNIT_TEST_PROJECTS = [
  "root-unit",
  "ui-unit",
  "root-memory",
  "cli-unit",
  "agent-runtime",
  "app-server",
  "sdk",
  "harness",
  "runtime",
  "evals",
] as const;

export const SYSTEM_TEST_PROJECTS = ["root-system", "actions"] as const;
export const INTEGRATION_TEST_PROJECTS = ["cli-integration"] as const;
export const IMAGE_TEST_PROJECTS = ["root-image"] as const;

export type PrimaryTestSuite =
  | "unit"
  | "system"
  | "integration"
  | "image"
  | "python"
  | "contract"
  | "release"
  | "live";
export type TestSuite = PrimaryTestSuite | "all" | "cli" | "agent-sdk";

export const ALL_TEST_SUITES: readonly PrimaryTestSuite[] = [
  "unit",
  "system",
  "integration",
  "image",
  "python",
  "contract",
  "release",
];
