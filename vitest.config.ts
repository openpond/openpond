import { defineConfig } from "vitest/config";

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
          name: "root-server",
          include: [
            "tests/**/*.test.{ts,tsx}",
            "apps/server/src/**/*.test.{ts,tsx}",
            "packages/cloud/src/**/*.test.{ts,tsx}",
          ],
        },
      },
      {
        extends: true,
        test: {
          ...shared,
          name: "cli",
          include: ["apps/cli/test/**/*.test.{ts,tsx}"],
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
      {
        extends: true,
        test: {
          ...shared,
          name: "package-sdks",
          include: [
            "packages/taskset-sdk/**/*.test.{ts,tsx}",
            "packages/training-sdk/**/*.test.{ts,tsx}",
          ],
        },
      },
    ],
  },
});
