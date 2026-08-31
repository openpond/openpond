import { defineConfig } from "vitest/config";
import {
  CLI_INTEGRATION_TESTS,
  CLI_RELEASE_TESTS,
  ROOT_IMAGE_TESTS,
  ROOT_MEMORY_TESTS,
  ROOT_SYSTEM_TESTS,
  ROOT_UI_TESTS,
} from "./scripts/test-suite-config";

const cliIntegrationTests = CLI_INTEGRATION_TESTS.map((entry) => `apps/cli/${entry}`);
const cliReleaseTests = CLI_RELEASE_TESTS.map((entry) => `apps/cli/${entry}`);

const common = {
  environment: "node" as const,
  globals: false,
  isolate: true,
  clearMocks: true,
  restoreMocks: true,
  hookTimeout: 60_000,
  testTimeout: 60_000,
};

const fast = {
  ...common,
  pool: "threads" as const,
  maxWorkers: process.env.CI ? 4 : "75%",
};

const forked = {
  ...common,
  pool: "forks" as const,
  maxWorkers: process.env.CI ? 4 : "75%",
};

const constrained = {
  ...common,
  pool: "forks" as const,
  maxWorkers: process.env.CI ? 2 : "50%",
  sequence: { groupOrder: 1 },
};

const memory = {
  ...common,
  pool: "forks" as const,
  execArgv: ["--expose-gc"],
  maxWorkers: 1,
  sequence: { groupOrder: 2 },
};

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "coverage/unit",
      include: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.ts"],
      exclude: ["**/*.test.{ts,tsx}", "**/dist/**", "**/generated/**"],
    },
    projects: [
      {
        extends: true,
        test: {
          ...fast,
          name: "root-unit",
          include: [
            "tests/**/*.test.ts",
            "apps/web/src/**/*.test.ts",
            "packages/cloud/src/**/*.test.ts",
          ],
          exclude: [
            ...ROOT_SYSTEM_TESTS,
            ...ROOT_MEMORY_TESTS,
            ...ROOT_IMAGE_TESTS,
          ],
        },
      },
      {
        extends: true,
        test: {
          ...fast,
          name: "ui-unit",
          include: [...ROOT_UI_TESTS],
        },
      },
      {
        extends: true,
        test: {
          ...constrained,
          name: "root-system",
          include: [...ROOT_SYSTEM_TESTS],
        },
      },
      {
        extends: true,
        test: {
          ...memory,
          name: "root-memory",
          include: [...ROOT_MEMORY_TESTS],
        },
      },
      {
        extends: true,
        test: {
          ...constrained,
          name: "root-image",
          include: [...ROOT_IMAGE_TESTS],
        },
      },
      {
        extends: true,
        test: {
          ...forked,
          name: "cli-unit",
          include: ["apps/cli/test/**/*.test.{ts,tsx}"],
          exclude: [...cliIntegrationTests, ...cliReleaseTests],
        },
      },
      {
        extends: true,
        test: {
          ...constrained,
          name: "cli-integration",
          include: [...cliIntegrationTests],
        },
      },
      {
        extends: true,
        test: {
          ...constrained,
          name: "cli-release",
          include: [...cliReleaseTests],
        },
      },
      {
        extends: true,
        test: {
          ...forked,
          name: "agent-runtime",
          include: ["packages/agent-runtime/test/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          ...forked,
          name: "app-server",
          include: ["packages/app-server/test/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          ...constrained,
          name: "actions",
          include: ["packages/actions/test/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          ...constrained,
          name: "agent-sdk",
          include: ["packages/agent-sdk/test/**/*.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          ...fast,
          name: "sdk",
          include: ["packages/sdk/test/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          ...fast,
          name: "harness",
          include: ["packages/harness/test/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          ...fast,
          name: "runtime",
          include: ["packages/runtime/tests/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          ...fast,
          name: "evals",
          include: ["packages/evals/test/**/*.test.ts"],
        },
      },
    ],
  },
});
