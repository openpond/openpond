import { defineConfig } from "vitest/config";
import {
  CLI_INTEGRATION_TESTS,
  CLI_RELEASE_TESTS,
  ROOT_INTEGRATION_TESTS,
} from "./scripts/test-suite-config";

const cliIntegrationTests = CLI_INTEGRATION_TESTS.map((entry) => `apps/cli/${entry}`);
const cliReleaseTests = CLI_RELEASE_TESTS.map((entry) => `apps/cli/${entry}`);

const shared = {
  environment: "node" as const,
  globals: false,
  isolate: true,
  clearMocks: true,
  restoreMocks: true,
  hookTimeout: 60_000,
  testTimeout: 60_000,
  pool: "forks" as const,
  execArgv: ["--expose-gc"],
  maxWorkers: process.env.CI ? 2 : "50%",
};

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          ...shared,
          name: "root-unit",
          include: [
            "tests/**/*.test.{ts,tsx}",
            "apps/server/src/**/*.test.{ts,tsx}",
            "packages/cloud/src/**/*.test.{ts,tsx}",
          ],
          exclude: [...ROOT_INTEGRATION_TESTS],
        },
      },
      {
        extends: true,
        test: {
          ...shared,
          name: "root-integration",
          include: [...ROOT_INTEGRATION_TESTS],
        },
      },
      {
        extends: true,
        test: {
          ...shared,
          name: "cli-unit",
          include: ["apps/cli/test/**/*.test.{ts,tsx}"],
          exclude: [...cliIntegrationTests, ...cliReleaseTests],
        },
      },
      {
        extends: true,
        test: {
          ...shared,
          name: "cli-integration",
          include: [...cliIntegrationTests],
        },
      },
      {
        extends: true,
        test: {
          ...shared,
          name: "cli-release",
          include: [...cliReleaseTests],
        },
      },
      {
        extends: true,
        test: {
          ...shared,
          name: "agent-sdk",
          include: ["packages/agent-sdk/test/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
