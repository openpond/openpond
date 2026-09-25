import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { AgentProjectDefinition } from "openpond-agent-sdk/primitives";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runTestProcess } from "../../../tests/helpers/run-process";

const packageRoot = path.resolve(import.meta.dirname, "..");
const fixtureRoot = path.join(packageRoot, ".openpond-test-fixtures", "pilot-examples-contract");

describe("pilot example contract", () => {
  beforeAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
    await mkdir(fixtureRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  test("covers TypeScript-generated prompts while preserving markdown-only prompts", async () => {
    const blankBuild = await runSdkJson(["build", "--json", "--cwd", example("blank-agent")]);
    expect(blankBuild.manifest.instructions.source).toBe("./agent/instructions.md");
    expect(blankBuild.manifest.skills[0]).toMatchObject({
      name: "basic",
      source: "./agent/skills/basic.md",
    });

    const customerBuild = await runSdkJson(["build", "--json", "--cwd", example("customer-reply-agent")]);
    expect(customerBuild.manifest.instructions).toMatchObject({
      source: "generated",
      artifactRef: ".openpond/prompts/instructions.md",
    });
    expect(customerBuild.manifest.skills[0]).toMatchObject({
      name: "reply-style",
      source: "generated",
      artifactRef: ".openpond/skills/reply-style/SKILL.md",
    });
    expect(customerBuild.manifest.skills[0].files[0]).toMatchObject({
      path: "references/tone.md",
      artifactRef: ".openpond/skills/reply-style/references/tone.md",
    });
    expect(await readFile(
      path.join(example("customer-reply-agent"), ".openpond", "prompts", "instructions.md"),
      "utf8",
    )).toContain("Do not invent commitments");
  });

  test("binds Cross-System Operations actions and tools to shared named input schemas", async () => {
    const project = await importProject("cross-system-operations");
    const expectedSchemaNames = [
      "query_billing.input",
      "run_python.input",
      "search_crm.input",
      "search_support.input",
    ];

    expect(Object.keys(project.inputSchemas ?? {}).sort()).toEqual(expectedSchemaNames);
    expect(
      project.actions
        .filter((entry) => entry.name !== "chat")
        .map((entry) => entry.inputSchema)
        .sort(),
    ).toEqual(expectedSchemaNames);
    expect(project.tools?.map((entry) => entry.inputSchema).sort()).toEqual(expectedSchemaNames);
  });

  test("detects manifest drift on a real pilot copy", async () => {
    const driftCwd = path.join(fixtureRoot, "blank-agent-drift");
    await cp(example("blank-agent"), driftCwd, { recursive: true });
    await rm(path.join(driftCwd, ".openpond"), { force: true, recursive: true });
    await writeFile(path.join(driftCwd, "openpond.yaml"), "name: drift\n", "utf8");

    const validation = await runSdkJsonAllowFailure(["validate", "--json", "--cwd", driftCwd]);
    expect(validation.exitCode).toBe(1);
    expect(validation.payload.issues.map((issue: Record<string, unknown>) => issue.code))
      .toContain("typescript_manifest_openpond_yaml_drift");
  });
});

async function importProject(name: string): Promise<AgentProjectDefinition> {
  const configPath = path.join(example(name), "agent", "agent.ts");
  const cacheKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const moduleUrl = `${pathToFileURL(configPath).href}?pilot=${cacheKey}`;
  const mod = await import(moduleUrl) as { default: AgentProjectDefinition };
  return mod.default;
}

function example(name: string) {
  return path.join(packageRoot, "examples", name);
}

async function runSdkJson(args: string[]) {
  const result = await runSdk(args);
  if (result.exitCode !== 0) throw new Error(formatFailure(args, result));
  return JSON.parse(result.stdout) as Record<string, any>;
}

async function runSdkJsonAllowFailure(args: string[]) {
  const result = await runSdk(args);
  if (!result.stdout.trim()) throw new Error(formatFailure(args, result));
  return {
    exitCode: result.exitCode,
    payload: JSON.parse(result.stdout) as Record<string, any>,
  };
}

async function runSdk(args: string[]) {
  return runTestProcess(process.execPath, ["./dist/cli.js", ...args], {
    cwd: packageRoot,
  });
}

function formatFailure(
  args: string[],
  result: { stdout: string; stderr: string; exitCode: number },
) {
  return [
    `openpond-agent ${args.join(" ")} failed with exit code ${result.exitCode}`,
    result.stdout.trim(),
    result.stderr.trim(),
  ].filter(Boolean).join("\n");
}
