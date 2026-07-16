import { describe, expect, test } from "vitest";
import {
  SubagentEvidenceRetentionPolicySchema,
  SubagentRuntimeEventNameSchema,
  SubagentRunSchema,
  SubagentRunStatusSchema,
} from "@openpond/contracts";

describe("subagent contracts", () => {
  test("constructs a generic child run with transport defaults", () => {
    const run = SubagentRunSchema.parse({
      id: "run_1",
      parentSessionId: "session_parent",
      roleId: "coding",
      objective: "Fix the failing test",
      createdAt: "2026-07-08T12:00:00.000Z",
    });

    expect(run.status).toBe("queued");
    expect(run.progress.phase).toBe("orient");
    expect(run).not.toHaveProperty("required");
    expect(run).not.toHaveProperty("workerBrief");
    expect(run).not.toHaveProperty("review");
    expect(run).not.toHaveProperty("reviewTargetRunId");
    expect(run.evidenceRetention).toEqual({
      kind: "retain_with_parent",
      messageRetentionDays: null,
      artifactRetentionDays: null,
      cleanupAfterExpiry: false,
    });
  });

  test("supports only generic lifecycle states and events", () => {
    for (const status of ["queued", "running", "completed", "failed", "cancelled", "needs_resume"] as const) {
      expect(SubagentRunStatusSchema.parse(status)).toBe(status);
    }
    expect(() => SubagentRunStatusSchema.parse("submitted_for_review")).toThrow();
    expect(() => SubagentRunStatusSchema.parse("accepted")).toThrow();
    expect(SubagentRuntimeEventNameSchema.parse("subagent.completed")).toBe("subagent.completed");
    expect(SubagentRuntimeEventNameSchema.parse("subagent.message")).toBe("subagent.message");
    expect(() => SubagentRuntimeEventNameSchema.parse("subagent.needs_revision")).toThrow();
  });

  test("keeps explicit evidence retention validation", () => {
    expect(SubagentEvidenceRetentionPolicySchema.parse({})).toMatchObject({ cleanupAfterExpiry: false });
    expect(() => SubagentEvidenceRetentionPolicySchema.parse({ messageRetentionDays: 0 })).toThrow();
  });
});
