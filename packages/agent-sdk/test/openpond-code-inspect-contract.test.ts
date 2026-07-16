import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";
import { runTestProcess } from "../../../tests/helpers/run-process";

const packageRoot = path.resolve(import.meta.dirname, "..");
const shapePath = path.join(packageRoot, "test", "fixtures", "openpond-code", "inspect-shape.json");

type ShapeRequirement = {
  path: string;
  type: "array" | "boolean" | "number" | "object" | "string" | "nullable-string";
  equals?: unknown;
};

describe("openpond-code inspect compatibility", () => {
  test("pins the inspect JSON shape consumed by platform tooling", async () => {
    const inspect = await runSdkJson([
      "inspect",
      "--json",
      "--cwd",
      "examples/integration-heavy-agent",
      "--out-dir",
      ".openpond",
    ]);
    const shape = JSON.parse(await readFile(shapePath, "utf8")) as {
      required: ShapeRequirement[];
    };

    for (const requirement of shape.required) {
      const value = getPath(inspect, requirement.path);
      expect(value, requirement.path).not.toBeUndefined();
      expectType(requirement.path, value, requirement.type);
      if ("equals" in requirement) {
        expect(value, requirement.path).toEqual(requirement.equals);
      }
    }

    const manifestHash = getPath(inspect, "agent.manifestHash");
    expect(typeof manifestHash).toBe("string");
    expect(manifestHash as string).toMatch(/^[a-f0-9]{64}$/);
  });
});

async function runSdkJson(args: string[]) {
  const result = await runSdk(args);
  if (result.exitCode !== 0) throw new Error(formatFailure(args, result));
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function runSdk(args: string[]) {
  return runTestProcess(process.execPath, ["./dist/cli.js", ...args], {
    cwd: packageRoot,
  });
}

function getPath(value: unknown, dottedPath: string): unknown {
  return dottedPath.split(".").reduce((current: unknown, segment) => {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(segment)) return current[Number(segment)];
    if (typeof current === "object") return (current as Record<string, unknown>)[segment];
    return undefined;
  }, value);
}

function expectType(pathLabel: string, value: unknown, expected: ShapeRequirement["type"]) {
  if (expected === "array") {
    expect(Array.isArray(value), pathLabel).toBe(true);
    return;
  }
  if (expected === "nullable-string") {
    expect(value === null || typeof value === "string", pathLabel).toBe(true);
    return;
  }
  if (expected === "object") {
    expect(typeof value === "object" && value !== null && !Array.isArray(value), pathLabel).toBe(true);
    return;
  }
  expect(typeof value, pathLabel).toBe(expected);
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
