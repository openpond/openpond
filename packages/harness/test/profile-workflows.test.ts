import { describe, expect, it } from "vitest";

import { contentHash } from "../src/common.js";
import { resolveProfileWorkflowBinding, validateProfileWorkflowCatalog } from "../src/profile-workflows.js";

const catalog = {
  schemaVersion: "openpond.profileWorkflows.v1",
  workflows: [{
    id: "summarize",
    label: "Summarize",
    description: "Summarize the supplied document.",
    inputSchema: { type: "object", properties: { document: { type: "string" } }, required: ["document"] },
    invocation: { kind: "instructions", instructions: "Summarize the document." },
    skillPaths: ["skills/research/SKILL.md"],
  }],
} as const;

const release = { id: "release-1", contentHash: "a".repeat(64) };
const sourcePaths = new Set(["skills/research/SKILL.md"]);

describe("Profile workflow source binding", () => {
  it("resolves only an exact released catalog and existing dependencies", () => {
    const validated = validateProfileWorkflowCatalog({ catalog, sourcePaths, actionIds: new Set() });
    const binding = {
      schemaVersion: "openpond.profileWorkflowBinding.v1",
      profileId: "team",
      sourceRevision: "1".repeat(40),
      harnessRelease: release,
      catalogHash: contentHash(validated),
      workflowId: "summarize",
    };
    expect(resolveProfileWorkflowBinding({ binding, catalog, sourcePaths, actionIds: new Set(), harnessRelease: release }).id).toBe("summarize");
    expect(() => resolveProfileWorkflowBinding({ binding, catalog: { ...catalog, workflows: [{ ...catalog.workflows[0], label: "Changed" }] }, sourcePaths, actionIds: new Set(), harnessRelease: release })).toThrow(/catalog differs/);
    expect(() => resolveProfileWorkflowBinding({ binding, catalog, sourcePaths, actionIds: new Set(), harnessRelease: { ...release, contentHash: "b".repeat(64) } })).toThrow(/release/);
    expect(() => validateProfileWorkflowCatalog({ catalog, sourcePaths: new Set(), actionIds: new Set() })).toThrow(/missing Skill/);
    expect(() => validateProfileWorkflowCatalog({ catalog: { ...catalog, workflows: [catalog.workflows[0], catalog.workflows[0]] }, sourcePaths, actionIds: new Set() })).toThrow(/Duplicate/);
    expect(() => validateProfileWorkflowCatalog({ catalog: { ...catalog, workflows: [{ ...catalog.workflows[0], skillPaths: ["../secret"] }] }, sourcePaths, actionIds: new Set() })).toThrow();
  });
});
