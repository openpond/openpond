import { expect, test } from "vitest";
import { TrainingTargetSchema, OpenPondTrainingProjectClient } from "../src/training-projects.js";

const source = {
  profileId: "support-profile",
  sourceRevision: "a".repeat(40),
  harnessRelease: { id: "harness-release", contentHash: "b".repeat(64) },
  catalogHash: "c".repeat(64),
  definitionId: "workflow-quality",
  definitionHash: "d".repeat(64),
  target: { kind: "workflow" as const, workflowId: "answer-ticket" },
  environmentHash: "e".repeat(64),
};

// A repository locator cannot be inferred from the portable Profile name.
// Losing it or accepting a changed readback could execute another published source.
test("Project writes retain distinct repository and Profile identities and reject substituted readback", async () => {
  const target = TrainingTargetSchema.parse({ kind: "harness", profileRepositoryId: "repository-123", source });
  if (target.kind !== "harness") throw new Error("Expected a harness target.");
  expect(() => TrainingTargetSchema.parse({ kind: "harness", source })).toThrow();
  const content = { name: "Support", description: "", targets: [{ id: "target-1", name: "Answer quality", target }], defaultTargetId: "target-1", resources: [] };
  let returnedContent = content;
  const client = new OpenPondTrainingProjectClient({
    baseUrl: "https://api.example.test", apiKey: "test-key", teamId: "team-1",
    fetch: async (_url, init) => {
      const sent = JSON.parse(String(init?.body));
      expect(sent.content.targets[0].target.profileRepositoryId).toBe("repository-123");
      expect(sent.content.targets[0].target.source.profileId).toBe("support-profile");
      return Response.json({ schemaVersion: "openpond.trainingProject.v1", id: "project-1", teamId: "team-1", creatorUserId: "user-1", revision: 1, content: returnedContent, archived: false, createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z" });
    },
  });
  const request = { operationId: "save-1", id: "project-1", expectedRevision: 0, content };
  await expect(client.save(request)).resolves.toMatchObject({ content });
  returnedContent = { ...content, targets: [{ ...content.targets[0]!, target: { ...target, profileRepositoryId: "another-repository" } }] };
  await expect(client.save(request)).rejects.toThrow("Project write revision mismatch");
});

// Suite membership cannot combine different source releases or duplicate one
// check to present it as several independent checks.
test("a Project suite binds unique definitions from one released source", () => {
  const next = { ...source, definitionId: "retention", environmentHash: "f".repeat(64) };
  const suite = { kind: "suite", profileRepositoryId: "repository-123", suiteId: "support-checks", sources: [source, next] };
  expect(TrainingTargetSchema.parse(suite)).toMatchObject(suite);
  expect(() => TrainingTargetSchema.parse({ ...suite, sources: [source, source] })).toThrow();
  for (const altered of [
    { ...next, profileId: "other-profile" },
    { ...next, sourceRevision: "b".repeat(40) },
    { ...next, catalogHash: "f".repeat(64) },
    { ...next, harnessRelease: { ...next.harnessRelease, contentHash: "f".repeat(64) } },
  ]) expect(() => TrainingTargetSchema.parse({ ...suite, sources: [source, altered] })).toThrow();
});
