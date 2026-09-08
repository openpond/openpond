import { expect, test } from "vitest";

import { createHarnessSourceRuntime } from "../src/index.js";
import { sourceRuntimeFixture } from "./source-runtime-fixture.js";

test("released source execution isolates private files and rejects unavailable required capabilities before policy work", () => {
  const source = sourceRuntimeFixture();
  const compile = (sourcePackage = source) => createHarnessSourceRuntime({
    sourcePackage, expectedRelease: { id: sourcePackage.harnessRelease.id, contentHash: sourcePackage.harnessRelease.contentHash },
    baseSystemPrompt: "Complete the task.", runtimeId: "test-runtime", tools: [], maxContextCharacters: 50_000,
  });
  const runtime = compile();
  expect(runtime.systemPrompt).not.toContain("PRIVATE_GRADER_SOURCE_NOT_POLICY_CONTEXT");
  expect(runtime.systemPrompt).not.toContain("private/grader.txt");
  expect(() => runtime.readFile({ path: "private/grader.txt" })).toThrow("not policy-visible");
  expect(() => runtime.readFile({ path: "../instructions/system.md" })).toThrow("not policy-visible");
  expect(runtime.readFile({ path: "skills/label/reference.txt", offset: 1, length: 2 })).toMatchObject({ content: "lu", nextOffset: 3, eof: false });
  expect(() => compile(sourceRuntimeFixture({ requiredCapability: "private_network_access" }))).toThrow("capability is unavailable");
  expect(() => createHarnessSourceRuntime({ sourcePackage: source, expectedRelease: { id: source.harnessRelease.id, contentHash: source.harnessRelease.contentHash },
    baseSystemPrompt: "Complete the task.", runtimeId: "test-runtime", tools: [], maxContextCharacters: 10 })).toThrow("context limit");
});
