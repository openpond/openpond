import { describe, expect, test, vi } from "vitest";
import { OpenPondLearningClient, learningRef, type LearningPolicy } from "openpond-sdk/learning";
import { runHostedLearningReview } from "./model-learning-review.js";

describe("hosted Model review boundary", () => {
  // A foreign evidence/receipt ID must not let the Desktop review pane mutate
  // another source, even though the saved hosted credential can access both.
  test("scopes reads and grading/corrections to the policy's exact source release", async () => {
    const source = { id: "source", revision: 1, contentHash: "a".repeat(64) };
    const definition = { id: "definition", revision: 1, contentHash: "b".repeat(64) };
    const evidence = { id: "evidence", revision: 1, contentHash: "c".repeat(64), source: learningRef(source), submission: { sourceId: source.id, taskDefinition: definition } };
    const policy = { sources: [learningRef(source)], taskDefinition: definition } as LearningPolicy;
    const transport = vi.fn(async () => Response.json({ items: [], nextCursor: null }));
    const client = new OpenPondLearningClient({ baseUrl: "https://test.invalid", apiKey: "test", scope: "team", fetch: transport });
    const get = vi.spyOn(client, "get").mockImplementation(async (kind, id) => {
      if (kind === "source") return source as never;
      if (kind === "grade") return { evidence: { ...learningRef(evidence), id: "foreign" } } as never;
      return (id === "foreign" ? { ...evidence, source: { ...source, id: "foreign-source" } } : evidence) as never;
    });
    const command = vi.spyOn(client, "command").mockResolvedValue({ operationId: "grade", resources: [] });
    const request = { scope: "untrusted", command: { action: "queue_grade", operationId: "grade", evidence: learningRef(evidence), target: "observed", proposedTarget: null, timeoutMs: 30_000, maximumSpendUsd: 0 } };
    await expect(runHostedLearningReview(client, policy, "other-source", "commands", request)).rejects.toMatchObject({ status: 403 });
    expect(get).not.toHaveBeenCalled();
    await expect(runHostedLearningReview(client, policy, "source", "commands", { ...request, command: { ...request.command, evidence: { ...request.command.evidence, id: "foreign" } } })).rejects.toMatchObject({ status: 403 });
    await expect(runHostedLearningReview(client, policy, "source", "commands", { scope: "team", command: { action: "cancel_grade", operationId: "cancel", gradeId: "foreign-grade", expectedRevision: 1 } })).rejects.toMatchObject({ status: 403 });
    await expect(runHostedLearningReview(client, policy, "source", "read", { scope: "team", action: "list", kind: "evidence" })).rejects.toMatchObject({ status: 403 });
    evidence.source = { ...source, revision: 2 };
    await expect(runHostedLearningReview(client, policy, "source", "commands", request)).rejects.toMatchObject({ status: 403 });
    expect(command).not.toHaveBeenCalled();
    evidence.source = learningRef(source);
    // First-page review reads must survive strict JSON validation in the real SDK.
    for (const kind of ["evidence", "grade", "decision", "feedback"]) {
      await expect(runHostedLearningReview(client, policy, "source", "read", { scope: "team", action: "list", kind, parentId: kind === "evidence" ? "source" : "evidence", limit: 30 })).resolves.toEqual({ items: [], nextCursor: null });
    }
    expect(transport).toHaveBeenCalledTimes(4);
    await runHostedLearningReview(client, policy, "source", "commands", request);
    expect(command).toHaveBeenCalledExactlyOnceWith(request.command);
  });
});
