import { describe, expect, it } from "vitest";
import { compileProfileWorkflowPackages, sha256 } from "@openpond/harness";

const prompt = `---
name: Brief
description: Produce a grounded brief.
---
Use only verified source data.\n`;

describe("authored Profile Workflow boundary", () => {
  it("compiles a prompt-only package deterministically and rejects missing or unsafe references", () => {
    const files = new Map([
      ["workflows/brief/PROMPT.md", prompt],
      ["workflows/brief/assets/source.txt", "fixture"],
    ]);
    const input = { files: new Map([["workflows/brief/PROMPT.md", prompt]]), skillPaths: new Set<string>(), actionIds: new Set<string>() };
    const first = compileProfileWorkflowPackages(input);
    const second = compileProfileWorkflowPackages({ ...input, files: new Map([...input.files].reverse()) });
    expect(sha256(JSON.stringify(first.catalog))).toBe(sha256(JSON.stringify(second.catalog)));
    expect(first.catalog.workflows[0]?.invocation).toEqual({
      kind: "instructions", instructions: "Use only verified source data.\n",
    });
    expect(() => compileProfileWorkflowPackages({ ...input, files: new Map([
      ["workflows/brief/PROMPT.md", ""],
    ]) })).toThrow(/nonempty Markdown prompt/);
    expect(() => compileProfileWorkflowPackages({ ...input, files: new Map([
      ["workflows/brief/PROMPT.md", prompt.replace("description: Produce a grounded brief.", "assetPaths: [../secret.txt]")],
    ]) })).toThrow();
    expect(() => compileProfileWorkflowPackages({ ...input, files })).toThrow(/Unreferenced/);
  });
});
