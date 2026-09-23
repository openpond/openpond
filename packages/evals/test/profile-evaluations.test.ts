import { describe, expect, it } from "vitest";

import { validateProfileEvaluationCatalog } from "../src/profile-evaluations.js";

const release = { id: "frozen-tasks", contentHash: "a".repeat(64) };
const definition = (id: string, target: object) => ({
  id, label: id, description: "", target, tasksetRelease: release,
  split: "frozen_eval", taskIds: ["case-1"], seeds: ["7"],
  criterion: { minimumPassRate: 1, requireComplete: true },
});
const sources = {
  workflowIds: new Set(["report"]), skillPaths: new Set(["skills/report/SKILL.md"]),
  actionIds: new Set(["write_report"]),
};

describe("portable Profile evaluation catalog", () => {
  it("pins component cases and requires an end-to-end definition in a Profile suite", () => {
    const catalog = {
      schemaVersion: "openpond.profileEvaluations.v1",
      definitions: [
        definition("workflow-check", { kind: "workflow", workflowId: "report" }),
        definition("profile-check", { kind: "profile" }),
      ],
      suites: [{ id: "profile-suite", label: "Profile suite", scope: "profile", definitionIds: ["workflow-check", "profile-check"] }],
    };
    const first = validateProfileEvaluationCatalog({ catalog, ...sources });
    expect(validateProfileEvaluationCatalog({ catalog, ...sources }).contentHash).toBe(first.contentHash);
    expect(() => validateProfileEvaluationCatalog({
      catalog: { ...catalog, suites: [{ ...catalog.suites[0], definitionIds: ["workflow-check"] }] }, ...sources,
    })).toThrow("needs an end-to-end Profile definition");
    expect(() => validateProfileEvaluationCatalog({ catalog, ...sources, workflowIds: new Set() })).toThrow("missing workflow");
  });
});
