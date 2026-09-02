import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { runBenchCommand } from "../src/cli/bench";

describe("openpond bench", () => {
  test("initializes and validates a manifest entirely locally", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-bench-"));
    const source = path.join(directory, "tasks.jsonl");
    const output = path.join(directory, "continual-bench.json");
    await writeFile(source, [
      { id: "a", familyId: "family", passLabel: "P0", prompt: "return a chair" },
      { id: "b", familyId: "family", passLabel: "P0", prompt: "exchange a bottle" },
    ].map((item) => JSON.stringify(item)).join("\n"), "utf8");
    const logs: string[] = [];
    let requests = 0;
    const request: typeof fetch = async () => { requests += 1; throw new Error("network must not be called"); };
    await runBenchCommand({ from: source, output, id: "fixture", name: "Fixture", license: "MIT", nonInteractive: true }, ["init"], { request, log: (message) => logs.push(message) });
    await runBenchCommand({ json: true }, ["validate", output], { request, log: (message) => logs.push(message) });
    expect(requests).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ schemaVersion: "openpond.continualBenchManifest.v1", id: "fixture" });
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ valid: true });
  });

  test("does not let run silently create a lifecycle without an OpenPond binding", async () => {
    const manifest = path.join(import.meta.dirname, "..", "..", "..", "examples", "tau3-retail-continual-v1", "continual-bench.json");
    await expect(runBenchCommand({}, ["run", manifest])).rejects.toThrow("needs an execution.openpond series binding");
  });
});
