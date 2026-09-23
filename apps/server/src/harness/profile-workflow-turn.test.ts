import { describe, expect, it } from "vitest";

import { prepareProfileWorkflowTurn } from "./profile-workflow-turn.js";

const workflow = {
  id: "report",
  label: "Report",
  description: "Write a report.",
  inputSchema: {
    type: "object",
    properties: { subject: { type: "string" } },
    required: ["subject"],
    additionalProperties: false,
  },
  invocation: { kind: "instructions" as const, instructions: "Write a concise report about the subject." },
  skillPaths: [],
};

describe("bound Profile workflow turn", () => {
  it("keeps released behavior separate from validated task input", () => {
    const prepared = prepareProfileWorkflowTurn({ workflow, value: { subject: "Solar energy" }, prompt: "Run the report" });
    expect(prepared.instruction).toContain("Write a concise report about the subject.");
    expect(prepared.prompt).toContain('"subject":"Solar energy"');
    expect(prepared.prompt).not.toContain("Write a concise report about the subject.");
    expect(prepared.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => prepareProfileWorkflowTurn({ workflow, value: { subject: 42 }, prompt: "Run" })).toThrow(/input is invalid/);
    expect(() => prepareProfileWorkflowTurn({ workflow, value: undefined, prompt: "Run" })).toThrow(/input is required/);
  });
});
