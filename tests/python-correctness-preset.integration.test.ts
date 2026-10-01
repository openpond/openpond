import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { createPythonCorrectnessPreset } from "../packages/evals/src/connected-evidence/python-correctness.js";
import { JavaScriptVerifierResultSchema } from "../packages/evals/src/javascript-verifier-contract.js";

// Failure story: a supplied correctness grader must execute admitted Python
// against private criteria in fresh namespaces, not grade syntax, invent gold,
// leak references, or turn missing runtime/evidence into a zero accuracy score.
test("Python preset executes private tests in fresh isolated namespaces and refuses missing evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "python-preset-boundary-"));
  try {
    const { reward, assets } = createPythonCorrectnessPreset();
    expect(reward.implementation).toMatchObject({ runtime: "sandbox_process", networkPolicy: "none" });
    expect(assets.every(asset => asset.asset.visibility === "verifier")).toBe(true);
    const modulePath = join(directory, "verifier.mjs"), secretPath = join(directory, "private-gold.txt");
    await writeFile(modulePath, assets[0]!.text);
    await writeFile(secretPath, "private-reference-should-never-be-readable");
    const { verify } = await import(/* @vite-ignore */ pathToFileURL(modulePath).href);
    const pythonSha256 = createHash("sha256").update(await readFile("/usr/bin/python3")).digest("hex");
    const task = { id: "case" };
    const runtime = { runtime: "bubblewrap-python-stdio-v1", pythonSha256 };
    const criteria = { runtime, schemaVersion: "openpond.pythonStdioTests.v1", tests: [{ stdin: "2 3\n", stdout: "5\n" }, { stdin: "1 9\n", stdout: "10\n" }] };
    const correct = await verify({ task, output: { answer: { pythonCode: "print(sum(map(int, input().split())))" } }, expectedOutput: { pythonCorrectness: criteria } });
    // This assertion intentionally fails when namespaces cannot execute. The
    // production preset reports unavailable, but absence is not qualification.
    expect(correct).toMatchObject({ score: 1, passed: true });
    expect(JavaScriptVerifierResultSchema.parse(correct).score).toBe(1);
    expect(await verify({ task, output: { pythonCode: "print(0)" }, expectedOutput: { pythonCorrectness: criteria } })).toMatchObject({ score: 0, passed: false });
    const isolationCode = `import os, socket\nfrom pathlib import Path\ntry:\n Path(${JSON.stringify(secretPath)}).read_text()\n print('leaked')\nexcept OSError:\n p=Path('/tmp/old-case'); print('old' if p.exists() else 'fresh'); p.write_text('retained')\ntry:\n socket.create_connection(('1.1.1.1', 80), timeout=0.1)\n print('network')\nexcept OSError:\n pass`;
    const isolated = await verify({ task, output: { pythonCode: isolationCode }, expectedOutput: { pythonCorrectness: {
      runtime, schemaVersion: criteria.schemaVersion, tests: [{ stdin: "", stdout: "fresh\n" }, { stdin: "", stdout: "fresh\n" }],
    } } });
    expect(isolated).toMatchObject({ score: 1, passed: true });
    const privateResult = await verify({ task, output: { pythonCode: "print('incorrect')" }, expectedOutput: { pythonCorrectness: {
      runtime, schemaVersion: criteria.schemaVersion, tests: [{ stdin: "", stdout: "private-reference-should-never-be-readable" }],
    } } });
    expect(JSON.stringify(privateResult)).not.toContain("private-reference-should-never-be-readable");
    expect(await verify({ task, output: { pythonCode: "while True: pass" }, expectedOutput: { pythonCorrectness: { ...criteria, tests: [criteria.tests[0]] } } })).toMatchObject({ score: 0, passed: false });
    for (const input of [
      { task, output: { answer: "ordinary chat" }, expectedOutput: { pythonCorrectness: criteria } },
      { task, output: { pythonCode: "print(5)" }, expectedOutput: null },
      { task, output: { pythonCode: "print(5)" }, expectedOutput: { pythonCorrectness: { ...criteria, runtime: null } } },
      { task, output: { pythonCode: "print(5)" }, expectedOutput: { pythonCorrectness: { ...criteria, runtime: { ...runtime, pythonSha256: "0".repeat(64) } } } },
    ]) expect(JavaScriptVerifierResultSchema.parse(await verify(input))).toMatchObject({ score: null, passed: false });
    expect(() => JavaScriptVerifierResultSchema.parse({ score: null, passed: true, feedback: "Invalid" })).toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
