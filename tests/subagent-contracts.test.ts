import {
  SubagentEvidenceRetentionPolicySchema,
  SubagentRunSchema
} from "@openpond/contracts";
import { describe, expect, test } from "vitest";

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
    expect(run.evidenceRetention).toEqual({
      kind: "retain_with_parent",
      messageRetentionDays: null,
      artifactRetentionDays: null,
      cleanupAfterExpiry: false,
    });
  });

  test("keeps explicit evidence retention validation", () => {
    expect(SubagentEvidenceRetentionPolicySchema.parse({})).toMatchObject({ cleanupAfterExpiry: false });
    expect(() => SubagentEvidenceRetentionPolicySchema.parse({ messageRetentionDays: 0 })).toThrow();
  });
});
