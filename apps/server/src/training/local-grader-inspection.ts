import { z } from "zod";
import type { LocalDatasetRecord, ChatResourceSummary } from "@openpond/contracts";

/** A grader inspection does not need task inputs or unrelated dataset files. */
export function localGraderInspection(record: LocalDatasetRecord, summary: ChatResourceSummary, payload: Record<string, unknown>) {
  const { offset, limit } = z.object({ offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(20) }).parse(payload);
  const draft = record.workspace.draft;
  const grader = draft.graders.find(grader => grader.id === summary.graderId)!;
  const fixtures = draft.graderFixtures.filter(fixture => !Array.isArray(fixture.metadata.graderIds) || fixture.metadata.graderIds.includes(grader.id));
  const module = grader.kind === "custom_verifier" ? record.workspace.files.find(file => file.path === grader.module) : null;
  const source = module ? Buffer.from(module.base64, "base64").toString("utf8") : null;
  return { summary, dataset: { id: draft.id, revision: draft.revision, name: draft.name, workspaceHash: record.workspace.contentHash },
    grader, taskCount: draft.tasks.length,
    fixtures: { total: fixtures.length, offset, items: fixtures.slice(offset, offset + limit), hasMore: offset + limit < fixtures.length },
    files: module ? [{ path: module.path, contentHash: module.contentHash, sizeBytes: module.sizeBytes,
      content: source!.slice(0, 24_000), truncated: source!.length > 24_000 }] : [] };
}
