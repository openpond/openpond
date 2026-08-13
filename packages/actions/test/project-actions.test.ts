import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { buildProjectActions } from "../src/build.js";
import {
  loadProjectActionConfiguration,
  resolveProjectActionRuntime,
} from "../src/configuration.js";
import { createLocalActionRunner } from "../src/local.js";
import { defineAction } from "../src/define-action.js";
import { z } from "zod";

const temporaryDirectories: string[] = [];
const actionsSource = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/index.ts",
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Project Actions", () => {
  test("builds deterministically and runs shared Project code in a child process", async () => {
    const projectRoot = await fixtureProject();
    const first = await buildProjectActions({ projectRoot });
    const second = await buildProjectActions({ projectRoot });

    expect(second.manifest.bundleHash).toBe(first.manifest.bundleHash);
    expect(second.manifest.registryHash).toBe(first.manifest.registryHash);
    expect(second.registry.actions).toEqual([
      expect.objectContaining({
        id: "analytics.get_summary",
        inputSchema: expect.objectContaining({ type: "object" }),
        outputSchema: expect.objectContaining({ type: "object" }),
        implementation: expect.objectContaining({ type: "openpond-project-action" }),
      }),
    ]);

    const runner = createLocalActionRunner({ projectRoot, build: "never" });
    const result = await runner.run<{ total: number }>({
      actionId: "analytics.get_summary",
      input: { businessId: "relocation" },
    });

    expect(result.output).toEqual({ total: 42 });
    expect(result.status).toBe("succeeded");
    expect(result.outputDirectory).toBe(path.join(projectRoot, ".openpond", "outputs", result.runId));
    expect(result.traces).toEqual([
      expect.objectContaining({ name: "analytics.loaded", payload: { businessId: "relocation" } }),
    ]);
  });

  test("rejects invalid input before calling the implementation", async () => {
    const projectRoot = await fixtureProject();
    const runner = createLocalActionRunner({ projectRoot, build: "always" });

    await expect(
      runner.run({ actionId: "analytics.get_summary", input: { businessId: 42 } }),
    ).rejects.toThrow(/Project Action process failed/);
    await expect(
      runner.run({ actionId: "analytics.get_summary", input: { businessId: "relocation" } }),
    ).resolves.toEqual(expect.objectContaining({ output: { total: 42 } }));
  });

  test("rejects malformed action definitions before discovery", () => {
    expect(() => defineAction("analytics.invalid", {
      description: "Invalid schema fixture.",
      input: {} as never,
      output: z.object({ ok: z.boolean() }),
      run: () => ({ ok: true }),
    })).toThrow("input must be a Zod schema");
  });

  test("requires declared local setup", async () => {
    const projectRoot = await fixtureProject({ requiresConnection: true });
    const runner = createLocalActionRunner({ projectRoot, build: "always" });

    await expect(
      runner.run({ actionId: "analytics.get_summary", input: { businessId: "relocation" } }),
    ).rejects.toThrow("Project Action connection is not configured: analytics-db");
  });

  test("preserves write approval metadata", async () => {
    const projectRoot = await fixtureProject({ behavior: "write" });
    const result = await buildProjectActions({ projectRoot });

    expect(result.registry.actions[0]).toEqual(expect.objectContaining({
      approvalPolicy: { mode: "writes", required: true, risk: "write" },
      implementation: expect.objectContaining({ behavior: "write" }),
    }));
  });

  test("captures stdout, stderr, traces, and verified output files", async () => {
    const projectRoot = await fixtureProject({ writesOutput: true });
    const result = await createLocalActionRunner({ projectRoot, build: "always" }).run({
      actionId: "analytics.get_summary",
      input: { businessId: "relocation" },
    });

    expect(result.stdout).toContain("analytics stdout");
    expect(result.stderr).toContain("analytics stderr");
    expect(result.outputs).toEqual([{ path: "summary.json", mimeType: "application/json" }]);
    await expect(
      fs.readFile(path.join(projectRoot, ".openpond", "outputs", result.runId, "summary.json"), "utf8"),
    ).resolves.toContain('"total":42');
  });

  test("rejects output paths outside the run output directory", async () => {
    const projectRoot = await fixtureProject({ escapesOutput: true });
    const runner = createLocalActionRunner({ projectRoot, build: "always" });

    await expect(runner.run({
      actionId: "analytics.get_summary",
      input: { businessId: "relocation" },
    })).rejects.toThrow("Project Action output must stay inside the run output directory");
  });

  test("reports action exceptions and output-schema failures", async () => {
    const exceptionProject = await fixtureProject({ throws: true });
    await expect(createLocalActionRunner({ projectRoot: exceptionProject, build: "always" }).run({
      actionId: "analytics.get_summary",
      input: { businessId: "relocation" },
    })).rejects.toThrow("analytics unavailable");

    const malformedProject = await fixtureProject({ malformedOutput: true });
    await expect(createLocalActionRunner({ projectRoot: malformedProject, build: "always" }).run({
      actionId: "analytics.get_summary",
      input: { businessId: "relocation" },
    })).rejects.toThrow("Project Action process failed");
  });

  test("supports timeouts and caller cancellation", async () => {
    const projectRoot = await fixtureProject({ delayMs: 10_000 });
    const runner = createLocalActionRunner({ projectRoot, build: "always" });
    await expect(runner.run({
      actionId: "analytics.get_summary",
      input: { businessId: "relocation" },
      timeoutMs: 25,
    })).rejects.toThrow("timed out after 25ms");

    const controller = new AbortController();
    const pending = runner.run({
      actionId: "analytics.get_summary",
      input: { businessId: "relocation" },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("cancelled by test")), 25);
    await expect(pending).rejects.toThrow("cancelled by test");

    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort(new Error("already cancelled"));
    await expect(runner.run({
      actionId: "analytics.get_summary",
      input: { businessId: "relocation" },
      signal: alreadyCancelled.signal,
    })).rejects.toThrow("already cancelled");
  });

  test("maps only declared host environment values into runtime setup", async () => {
    const projectRoot = await fixtureProject({ requiresConnection: true });
    await fs.writeFile(path.join(projectRoot, "openpond", "project-actions.json"), JSON.stringify({
      environment: { apiToken: "CUSTOMER_API_TOKEN" },
      connections: {
        "analytics-db": {
          values: { provider: "postgres" },
          environment: { url: "CUSTOMER_DATABASE_URL" },
        },
      },
    }), "utf8");
    const config = await loadProjectActionConfiguration(projectRoot);
    const runtime = resolveProjectActionRuntime(config, {
      CUSTOMER_API_TOKEN: "token-value",
      CUSTOMER_DATABASE_URL: "postgres://fixture",
      UNDECLARED_SECRET: "must-not-pass",
    });

    expect(runtime).toEqual({
      environment: { apiToken: "token-value" },
      connections: { "analytics-db": { provider: "postgres", url: "postgres://fixture" } },
    });
    const result = await createLocalActionRunner({ projectRoot, build: "always" }).run({
      actionId: "analytics.get_summary",
      input: { businessId: "relocation" },
    });
    expect(result.output).toEqual({ total: 42 });
  });

  test("redacts configured runtime values from stdout, stderr, and traces", async () => {
    const projectRoot = await fixtureProject({ echoesSecret: true });
    const result = await createLocalActionRunner({ projectRoot, build: "always" }).run({
      actionId: "analytics.get_summary",
      input: { businessId: "relocation" },
      environment: { apiToken: "fixture-super-secret" },
    });

    expect(result.stdout).not.toContain("fixture-super-secret");
    expect(result.stderr).not.toContain("fixture-super-secret");
    expect(JSON.stringify(result.traces)).not.toContain("fixture-super-secret");
    expect(result.stdout).toContain("[REDACTED]");
  });

  test("redacts configured values from failed child-process errors", async () => {
    const projectRoot = await fixtureProject({ throwsConfiguredSecret: true });
    await fs.writeFile(path.join(projectRoot, "openpond", "project-actions.json"), JSON.stringify({
      environment: { apiToken: "PROJECT_ACTION_TEST_SECRET" },
    }), "utf8");
    const previous = process.env.PROJECT_ACTION_TEST_SECRET;
    process.env.PROJECT_ACTION_TEST_SECRET = "failure-super-secret";
    try {
      await expect(createLocalActionRunner({ projectRoot, build: "always" }).run({
        actionId: "analytics.get_summary",
        input: { businessId: "relocation" },
      })).rejects.toThrow("[REDACTED]");
    } finally {
      if (previous === undefined) delete process.env.PROJECT_ACTION_TEST_SECRET;
      else process.env.PROJECT_ACTION_TEST_SECRET = previous;
    }
  });

  test("validates declared package and native tool setup", async () => {
    const projectRoot = await fixtureProject({
      additionalSetup: [
        { kind: "package", name: "zod" },
        { kind: "native_tool", name: path.basename(process.execPath) },
      ],
    });
    await expect(createLocalActionRunner({ projectRoot, build: "always" }).run({
      actionId: "analytics.get_summary",
      input: { businessId: "relocation" },
    })).resolves.toEqual(expect.objectContaining({ status: "succeeded" }));

    const missing = await fixtureProject({
      additionalSetup: [{ kind: "package", name: "definitely-not-installed-openpond-fixture" }],
    });
    await expect(buildProjectActions({ projectRoot: missing })).rejects.toThrow(
      "Project Action package is not installed",
    );
  });

  test("enforces declared local concurrency across child processes", async () => {
    const projectRoot = await fixtureProject({ concurrency: 1, delayMs: 150 });
    const runner = createLocalActionRunner({ projectRoot, build: "if-missing" });
    await runner.build();
    const startedAt = Date.now();

    const results = await Promise.all([
      runner.run({ actionId: "analytics.get_summary", input: { businessId: "relocation" } }),
      runner.run({ actionId: "analytics.get_summary", input: { businessId: "relocation" } }),
    ]);

    expect(results).toHaveLength(2);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
  });
});

async function fixtureProject(input: {
  behavior?: "read" | "write";
  concurrency?: number;
  additionalSetup?: Array<{ kind: "package" | "native_tool"; name: string }>;
  delayMs?: number;
  escapesOutput?: boolean;
  echoesSecret?: boolean;
  malformedOutput?: boolean;
  requiresConnection?: boolean;
  throws?: boolean;
  throwsConfiguredSecret?: boolean;
  writesOutput?: boolean;
} = {}): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-project-actions-"));
  temporaryDirectories.push(projectRoot);
  await fs.mkdir(path.join(projectRoot, "openpond", "actions"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "packages", "domain"), { recursive: true });
  if (input.additionalSetup?.some((requirement) => requirement.kind === "package" && requirement.name === "zod")) {
    const zodPackage = createRequire(import.meta.url).resolve("zod/package.json");
    await fs.mkdir(path.join(projectRoot, "node_modules"), { recursive: true });
    await fs.symlink(path.dirname(zodPackage), path.join(projectRoot, "node_modules", "zod"), "dir");
  }
  await fs.writeFile(
    path.join(projectRoot, "packages", "domain", "analytics.ts"),
    [
      "export function getAnalytics(businessId: string) {",
      "  return { total: businessId === 'relocation' ? 42 : 0 };",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(projectRoot, "openpond", "actions", "analytics.ts"),
    [
      "import { promises as fs } from 'node:fs';",
      "import path from 'node:path';",
      `import { defineAction } from ${JSON.stringify(actionsSource)};`,
      "import { z } from 'zod';",
      "import { getAnalytics } from '../../packages/domain/analytics.ts';",
      "export const getSummary = defineAction('analytics.get_summary', {",
      "  description: 'Return the analytics summary for one business.',",
      "  input: z.object({ businessId: z.string() }),",
      "  output: z.object({ total: z.number() }),",
      `  behavior: ${JSON.stringify(input.behavior ?? "read")},`,
      input.concurrency ? `  concurrency: ${input.concurrency},` : "",
      `  setup: ${JSON.stringify([
        ...(input.requiresConnection ? [{ kind: "connection", name: "analytics-db" }] : []),
        ...(input.additionalSetup ?? []),
      ])},`,
      "  async run(context, input) {",
      "    context.trace('analytics.loaded', { businessId: input.businessId });",
      input.delayMs ? `    await new Promise((resolve) => setTimeout(resolve, ${input.delayMs}));` : "",
      input.throws ? "    throw new Error('analytics unavailable');" : "",
      input.throwsConfiguredSecret ? "    throw new Error(`failed with ${context.env('apiToken')}`);" : "",
      input.writesOutput ? "    console.log('analytics stdout');" : "",
      input.writesOutput ? "    console.error('analytics stderr');" : "",
      input.echoesSecret ? "    console.log(context.env('apiToken'));" : "",
      input.echoesSecret ? "    console.error(context.env('apiToken'));" : "",
      input.echoesSecret ? "    context.trace('secret.loaded', { value: context.env('apiToken') });" : "",
      input.writesOutput ? "    await fs.writeFile(path.join(context.outputDirectory, 'summary.json'), JSON.stringify(getAnalytics(input.businessId)));" : "",
      input.writesOutput ? "    context.output({ path: 'summary.json', mimeType: 'application/json' });" : "",
      input.escapesOutput ? "    context.output({ path: '../escape.json' });" : "",
      input.malformedOutput ? "    return { total: 'wrong' };" : "    return getAnalytics(input.businessId);",
      "  },",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return projectRoot;
}
